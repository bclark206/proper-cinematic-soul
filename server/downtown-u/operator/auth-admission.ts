import { isIP } from "node:net";
import {
  type OperatorAuthCryptography,
  OperatorAuthConfigurationError,
  canonicalizeOperatorActorIp,
  createOperatorAuthCryptography,
} from "./auth-crypto";

const MAX_REDIS_RESPONSE_BYTES = 4_096;
const DEFAULT_REDIS_TIMEOUT_MS = 2_000;

type Limit = readonly [limit: number, windowSeconds: number];
type Headers = Record<string, string | string[] | undefined>;
type Fetch = typeof fetch;

export const OPERATOR_AUTH_ADMISSION_POLICIES = Object.freeze({
  requestLink: Object.freeze({ actor: Object.freeze([5, 15 * 60]) as Limit,
    contact: Object.freeze([3, 15 * 60]) as Limit,
    global: Object.freeze([100, 5 * 60]) as Limit }),
  emailVerify: Object.freeze({ actor: Object.freeze([10, 15 * 60]) as Limit }),
  smsVerify: Object.freeze({ actor: Object.freeze([15, 15 * 60]) as Limit }),
  reauthIssuance: Object.freeze({ actor: Object.freeze([5, 10 * 60]) as Limit,
    session: Object.freeze([3, 10 * 60]) as Limit }),
  reauthVerify: Object.freeze({ actor: Object.freeze([15, 15 * 60]) as Limit,
    session: Object.freeze([10, 10 * 60]) as Limit }),
});

type PolicyCategory = "actor" | "contact" | "session" | "global";
interface ScriptLimit { readonly category: PolicyCategory; readonly limit: number; readonly window: number }

// Every endpoint gets one fixed all-or-nothing script. Categories are not shared
// with student authentication, and no caller controls a namespace or ceiling.
function fixedScript(endpoint: string, limits: readonly ScriptLimit[]): string {
  const lines = ["local now = tonumber(redis.call('TIME')[1])"];
  let argument = 1;
  for (const item of limits) {
    const suffix = item.category === "global" ? "" : ` .. ':' .. ARGV[${argument++}]`;
    lines.push(`local ${item.category}_window = math.floor(now / ${item.window})`);
    lines.push(`local ${item.category}_key = 'du:operator-auth:${item.category}:v1:${endpoint}'${suffix} .. ':' .. ${item.category}_window`);
    lines.push(`local ${item.category}_count = tonumber(redis.call('GET', ${item.category}_key) or '0')`);
  }
  lines.push(`if ${limits.map((item) => `${item.category}_count >= ${item.limit}`).join(" or ")} then return 0 end`);
  for (const item of limits) {
    lines.push(`redis.call('INCR', ${item.category}_key)`);
    lines.push(`redis.call('EXPIRE', ${item.category}_key, ${item.window})`);
  }
  lines.push("return 1");
  return lines.join("\n");
}

const REQUEST_LINK_SCRIPT = fixedScript("request-link", [
  { category: "actor", limit: 5, window: 900 },
  { category: "contact", limit: 3, window: 900 },
  { category: "global", limit: 100, window: 300 },
]);
const EMAIL_VERIFY_SCRIPT = fixedScript("email-verify", [
  { category: "actor", limit: 10, window: 900 },
]);
const SMS_VERIFY_SCRIPT = fixedScript("sms-verify", [
  { category: "actor", limit: 15, window: 900 },
]);
const REAUTH_ISSUANCE_SCRIPT = fixedScript("reauth-issuance", [
  { category: "actor", limit: 5, window: 600 },
  { category: "session", limit: 3, window: 600 },
]);
const REAUTH_VERIFY_SCRIPT = fixedScript("reauth-verify", [
  { category: "actor", limit: 15, window: 900 },
  { category: "session", limit: 10, window: 600 },
]);

export class OperatorAuthAdmissionConfigurationError extends Error {
  constructor() {
    super("Operator authentication request admission is not configured");
    this.name = "OperatorAuthAdmissionConfigurationError";
  }
}

function redisOrigin(value: string | undefined): string {
  if (!value) throw new OperatorAuthAdmissionConfigurationError();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new OperatorAuthAdmissionConfigurationError(); }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io$/.test(parsed.hostname)) {
    throw new OperatorAuthAdmissionConfigurationError();
  }
  return parsed.origin;
}

function requiredToken(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n]/.test(value)) {
    throw new OperatorAuthAdmissionConfigurationError();
  }
  return value;
}

function trustedActor(headers: Headers): string | undefined {
  const names = Object.keys(headers).filter((name) => name.toLowerCase() === "x-vercel-forwarded-for");
  if (names.length !== 1) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(headers, names[0]);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
  const value = descriptor.value;
  if (!value || value.trim() !== value || value.includes(",") || isIP(value) === 0) return undefined;
  return canonicalizeOperatorActorIp(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("operator admission response rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REDIS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("operator admission response rejected");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("operator admission response rejected");
  }
}

export interface OperatorAuthAdmissionGuard {
  admitRequestLink(headers: Headers, normalizedEmail: string): Promise<boolean>;
  admitEmailVerification(headers: Headers): Promise<boolean>;
  admitSmsVerification(headers: Headers): Promise<boolean>;
  admitReauthIssuance(headers: Headers, sessionId: string): Promise<boolean>;
  admitReauthVerification(headers: Headers, sessionId: string): Promise<boolean>;
}

export function createOperatorAuthAdmissionGuard(
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch = fetch,
  timeoutMs = DEFAULT_REDIS_TIMEOUT_MS,
): OperatorAuthAdmissionGuard {
  if (env.VERCEL !== "1") throw new OperatorAuthAdmissionConfigurationError();
  const origin = redisOrigin(env.UPSTASH_REDIS_REST_URL);
  const token = requiredToken(env.UPSTASH_REDIS_REST_TOKEN);
  if (env.DOWNTOWN_U_OPERATOR_AUTH_SECRET === env.DOWNTOWN_U_AUTH_SECRET) {
    throw new OperatorAuthAdmissionConfigurationError();
  }
  let cryptography: OperatorAuthCryptography;
  try {
    cryptography = createOperatorAuthCryptography(env.DOWNTOWN_U_OPERATOR_AUTH_SECRET);
  } catch (error) {
    if (error instanceof OperatorAuthConfigurationError) throw new OperatorAuthAdmissionConfigurationError();
    throw error;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new OperatorAuthAdmissionConfigurationError();
  }

  async function evaluate(script: string, pseudonyms: readonly Buffer[]): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/eval`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([script, "0", ...pseudonyms.map((value) => value.toString("hex"))]),
        signal: controller.signal,
      });
      const result = await boundedJson(response);
      return typeof result === "object" && result !== null && !Array.isArray(result)
        && Object.keys(result).length === 1
        && Object.getOwnPropertyDescriptor(result, "result")?.value === 1;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function actorDigest(headers: Headers): Buffer | undefined {
    const actor = trustedActor(headers);
    if (!actor) return undefined;
    return cryptography.digestAdmissionActor(actor);
  }

  return Object.freeze({
    async admitRequestLink(headers: Headers, normalizedEmail: string): Promise<boolean> {
      try {
        const actor = actorDigest(headers);
        if (!actor) return false;
        const contact = cryptography.digestAdmissionContact(normalizedEmail);
        return evaluate(REQUEST_LINK_SCRIPT, [actor, contact]);
      } catch { return false; }
    },
    async admitEmailVerification(headers: Headers): Promise<boolean> {
      const actor = actorDigest(headers);
      return actor ? evaluate(EMAIL_VERIFY_SCRIPT, [actor]) : false;
    },
    async admitSmsVerification(headers: Headers): Promise<boolean> {
      const actor = actorDigest(headers);
      return actor ? evaluate(SMS_VERIFY_SCRIPT, [actor]) : false;
    },
    async admitReauthIssuance(headers: Headers, sessionId: string): Promise<boolean> {
      try {
        const actor = actorDigest(headers);
        if (!actor) return false;
        return evaluate(REAUTH_ISSUANCE_SCRIPT, [actor, cryptography.digestAdmissionSession(sessionId)]);
      } catch { return false; }
    },
    async admitReauthVerification(headers: Headers, sessionId: string): Promise<boolean> {
      try {
        const actor = actorDigest(headers);
        if (!actor) return false;
        return evaluate(REAUTH_VERIFY_SCRIPT, [actor, cryptography.digestAdmissionSession(sessionId)]);
      } catch { return false; }
    },
  });
}
