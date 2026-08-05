import { isIP } from "node:net";
import { createAuthCryptography } from "./auth";

export const AUTH_ACTOR_LIMIT = 5;
export const AUTH_ACTOR_WINDOW_SECONDS = 15 * 60;
export const AUTH_GLOBAL_LIMIT = 100;
export const AUTH_GLOBAL_WINDOW_SECONDS = 5 * 60;
const MAX_REDIS_RESPONSE_BYTES = 4_096;
const DEFAULT_REDIS_TIMEOUT_MS = 2_000;

// Limits, windows, key namespaces, and TTLs live only in this audited script. The
// caller supplies one HMAC pseudonym and cannot weaken policy through arguments.
const ADMISSION_SCRIPT = `local now = tonumber(redis.call('TIME')[1])
local actor_window = math.floor(now / ${AUTH_ACTOR_WINDOW_SECONDS})
local global_window = math.floor(now / ${AUTH_GLOBAL_WINDOW_SECONDS})
local actor_key = 'du:auth:actor:v1:' .. ARGV[1] .. ':' .. actor_window
local global_key = 'du:auth:global:v1:' .. global_window
local actor_count = tonumber(redis.call('GET', actor_key) or '0')
local global_count = tonumber(redis.call('GET', global_key) or '0')
if actor_count >= ${AUTH_ACTOR_LIMIT} or global_count >= ${AUTH_GLOBAL_LIMIT} then return 0 end
redis.call('INCR', actor_key)
redis.call('EXPIRE', actor_key, ${AUTH_ACTOR_WINDOW_SECONDS})
redis.call('INCR', global_key)
redis.call('EXPIRE', global_key, ${AUTH_GLOBAL_WINDOW_SECONDS})
return 1`;

type Headers = Record<string, string | string[] | undefined>;
type Fetch = typeof fetch;

export class AuthAdmissionConfigurationError extends Error {
  constructor() {
    super("Authentication request admission is not configured");
    this.name = "AuthAdmissionConfigurationError";
  }
}
export class AuthAdmissionError extends Error {
  constructor() {
    super("Authentication request admission failed");
    this.name = "AuthAdmissionError";
  }
}
export interface AuthRequestAdmissionGuard { admit(headers: Headers): Promise<boolean> }

function redisOrigin(value: string | undefined): string {
  if (!value) throw new AuthAdmissionConfigurationError();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AuthAdmissionConfigurationError(); }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io$/.test(parsed.hostname)) {
    throw new AuthAdmissionConfigurationError();
  }
  return parsed.origin;
}

function requiredToken(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n]/.test(value)) throw new AuthAdmissionConfigurationError();
  return value;
}

function trustedActor(headers: Headers): string | undefined {
  const matching = Object.keys(headers).filter((name) => name.toLowerCase() === "x-vercel-forwarded-for");
  if (matching.length !== 1) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(headers, matching[0]);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
  const value = descriptor.value;
  if (!value || value.trim() !== value || value.includes(",") || isIP(value) === 0) return undefined;
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new AuthAdmissionError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REDIS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AuthAdmissionError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AuthAdmissionError(); }
}

export function createAuthRequestAdmissionGuard(
  env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch, timeoutMs = DEFAULT_REDIS_TIMEOUT_MS,
): AuthRequestAdmissionGuard {
  if (env.VERCEL !== "1") throw new AuthAdmissionConfigurationError();
  const origin = redisOrigin(env.UPSTASH_REDIS_REST_URL);
  const token = requiredToken(env.UPSTASH_REDIS_REST_TOKEN);
  const cryptography = createAuthCryptography(env.DOWNTOWN_U_AUTH_SECRET);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new AuthAdmissionConfigurationError();

  return Object.freeze({
    async admit(headers: Headers): Promise<boolean> {
      const actor = trustedActor(headers);
      if (!actor) return false;
      const actorKey = cryptography.digestRequestActor(actor).toString("hex");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const redisResponse = await fetchImpl(`${origin}/eval`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify([ADMISSION_SCRIPT, "0", actorKey]),
          signal: controller.signal,
        });
        const result = await boundedJson(redisResponse);
        return typeof result === "object" && result !== null && !Array.isArray(result)
          && Object.keys(result).length === 1
          && Object.getOwnPropertyDescriptor(result, "result")?.value === 1;
      } catch { return false; }
      finally { clearTimeout(timer); }
    },
  });
}