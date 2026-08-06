import { createHmac } from "node:crypto";
import { exactOwnData, isCanonicalLowercaseUuid } from "./trusted-result";

export interface OperatorEligibilityAdmissionInput {
  readonly sessionId: string; readonly targetId: string; readonly origin: string;
  readonly secFetchSite: "same-origin"; readonly correlationId: string;
}
export type OperatorEligibilityAdmissionResult = Readonly<{ outcome: "admitted" | "limited" | "unavailable" }>;
export interface OperatorEligibilityAdmission { admit(input: OperatorEligibilityAdmissionInput): Promise<OperatorEligibilityAdmissionResult> }

const SCRIPT = [
  "local now=tonumber(redis.call('TIME')[1])",
  "local window=math.floor(now/60)",
  "local session_key='du:operator-mutation:session:v1:'..ARGV[1]..':'..window",
  "local target_key='du:operator-mutation:target:v1:'..ARGV[2]..':'..window",
  "local global_key='du:operator-mutation:global:v1:'..window",
  "local s=tonumber(redis.call('GET',session_key) or '0')",
  "local t=tonumber(redis.call('GET',target_key) or '0')",
  "local g=tonumber(redis.call('GET',global_key) or '0')",
  "if s>=20 or t>=10 or g>=500 then return 0 end",
  "redis.call('INCR',session_key) redis.call('EXPIRE',session_key,60)",
  "redis.call('INCR',target_key) redis.call('EXPIRE',target_key,60)",
  "redis.call('INCR',global_key) redis.call('EXPIRE',global_key,60)",
  "return 1",
].join("\n");
function configuration(): never { throw new Error("Operator eligibility admission unavailable"); }
function redisOrigin(raw: string | undefined): string {
  if (!raw) configuration(); let url: URL; try { url = new URL(raw); } catch { configuration(); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io$/.test(url.hostname)) configuration();
  return url.origin;
}
async function boundedResult(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("admission unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new Error("admission unavailable"); }
    chunks.push(Uint8Array.from(part.value));
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
export function createOperatorEligibilityAdmission(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): OperatorEligibilityAdmission {
  if (env.VERCEL !== "1") configuration();
  const origin = redisOrigin(env.UPSTASH_REDIS_REST_URL);
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const encodedKey = env.DOWNTOWN_U_OPERATOR_AUTH_SECRET;
  if (!token || token.length > 4096 || /[\r\n]/.test(token) || !encodedKey) configuration();
  const key = Buffer.from(encodedKey, "base64url"); if (key.length !== 32 || key.toString("base64url") !== encodedKey) configuration();
  const digest = (domain: string, value: string) => createHmac("sha256", key).update(domain).update(Buffer.from([0])).update(value).digest("hex");
  return Object.freeze({
    async admit(input: OperatorEligibilityAdmissionInput): Promise<OperatorEligibilityAdmissionResult> {
      try {
        const trusted = exactOwnData(input, ["sessionId", "targetId", "origin", "secFetchSite", "correlationId"]);
        if (!trusted || !isCanonicalLowercaseUuid(trusted.sessionId) || !isCanonicalLowercaseUuid(trusted.targetId)
          || trusted.secFetchSite !== "same-origin" || !validOrigin(trusted.origin)
          || typeof trusted.correlationId !== "string" || !/^operator-mutation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trusted.correlationId)) {
          return Object.freeze({ outcome: "unavailable" });
        }
        const sessionId = `${trusted.sessionId}`; const targetId = `${trusted.targetId}`;
        const session = digest("operator-mutation-admission:v1:session", sessionId);
        const target = digest("operator-mutation-admission:v1:target", targetId);
        const response = await fetchImpl(`${origin}/eval`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify([SCRIPT, "0", session, target]), signal: AbortSignal.timeout(2_000),
        });
        const result = await boundedResult(response);
        if (typeof result !== "object" || result === null || Array.isArray(result) || Object.keys(result).length !== 1) return Object.freeze({ outcome: "unavailable" });
        const value = Object.getOwnPropertyDescriptor(result, "result")?.value;
        return Object.freeze({ outcome: value === 1 ? "admitted" : value === 0 ? "limited" : "unavailable" });
      } catch { return Object.freeze({ outcome: "unavailable" }); }
    },
  });
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value && parsed.pathname === "/"
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}
