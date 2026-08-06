import type { EligibilityStatus } from "./types";

export type EligibilityDecision = "approve" | "reject" | "suspend" | "reinstate";
export type EligibilityReasonCode = "documentation_verified" | "documentation_incomplete" | "policy_ineligible" | "safety_hold" | "policy_hold" | "hold_cleared";
export interface EligibilityMutation {
  studentId: string;
  expectedStatus: EligibilityStatus;
  expectedUpdatedAt: string;
  decision: EligibilityDecision;
  reasonCode: EligibilityReasonCode;
  reason: string;
}
export interface EligibilityResult {
  studentId: string;
  eligibilityStatus: Exclude<EligibilityStatus, "pending">;
  eligibilityReviewedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  suspendedAt?: string;
  updatedAt: string;
}
export type EligibilityErrorKind = "session" | "forbidden" | "not_found" | "conflict" | "reauth" | "limited" | "unavailable" | "timeout";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const IDEMPOTENCY_KEY = new RegExp(`^opm:v1:${UUID_SOURCE}$`);
const CORRELATION = new RegExp(`^operator-mutation:${UUID_SOURCE}$`);
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const pairs: Record<EligibilityDecision, readonly EligibilityReasonCode[]> = {
  approve: ["documentation_verified"],
  reject: ["documentation_incomplete", "policy_ineligible"],
  suspend: ["safety_hold", "policy_hold"],
  reinstate: ["hold_cleared"],
};

export class EligibilityMutationRequestError extends Error {
  readonly retryable: boolean;
  constructor(public readonly kind: EligibilityErrorKind, public readonly correlationId?: string) {
    super(generic(kind));
    this.name = "EligibilityMutationRequestError";
    this.retryable = ["limited", "unavailable", "timeout"].includes(kind);
  }
}

function generic(kind: EligibilityErrorKind) {
  if (kind === "session") return "Your session has ended.";
  if (kind === "forbidden") return "Eligibility access changed.";
  if (kind === "conflict") return "The student record changed.";
  if (kind === "reauth") return "Verification is required.";
  return "The decision is unavailable.";
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function scalarSafe(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function canonicalizeEligibilityReason(decision: EligibilityDecision, code: EligibilityReasonCode, note: string) {
  if (!pairs[decision]?.includes(code) || typeof note !== "string") throw new Error("invalid reason");
  const value = note.trim().normalize("NFC");
  if (!scalarSafe(value)) throw new Error("invalid reason");
  const count = Array.from(value).length;
  if (count < 1 || count > 500) throw new Error("invalid reason");
  return value;
}

export function newEligibilityIdempotencyKey() {
  const id = crypto.randomUUID();
  if (!UUID.test(id)) throw new Error("unavailable");
  return `opm:v1:${id}`;
}

function headers(key?: string) {
  return { "Content-Type": "application/json", Origin: window.location.origin, ...(key ? { "Idempotency-Key": key } : {}) };
}

async function bounded(response: Response, maximum = 64 * 1024) {
  if (!/^application\/json; charset=utf-8$/i.test(response.headers.get("content-type") ?? "")) throw new EligibilityMutationRequestError("unavailable");
  const length = response.headers.get("content-length");
  if ((length && (!/^\d+$/.test(length) || Number(length) > maximum)) || !response.body) throw new EligibilityMutationRequestError("unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("oversized");
      }
      chunks.push(part.value.slice());
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)) as unknown;
  } catch {
    throw new EligibilityMutationRequestError("unavailable");
  }
}

type ErrorClassifier = (status: number, value: unknown) => EligibilityErrorKind | undefined;

function exactError(value: unknown, code: string): boolean {
  return exact(value, ["error"]) && value.error === code;
}

const eligibilityError: ErrorClassifier = (status, value) => {
  if (status === 400 && exactError(value, "invalid_request")) return "unavailable";
  if (status === 401 && exactError(value, "unauthorized")) return "session";
  if (status === 403 && exactError(value, "forbidden")) return "forbidden";
  if (status === 404 && exactError(value, "not_found")) return "not_found";
  if (status === 405 && exactError(value, "method_not_allowed")) return "unavailable";
  if (status === 409 && ["stale_state", "conflict", "idempotency_conflict"].some((code) => exactError(value, code))) return "conflict";
  if (status === 428 && exactError(value, "reauth_required")) return "reauth";
  if (status === 429 && exactError(value, "rate_limited")) return "limited";
  if (status === 503 && exactError(value, "unavailable")) return "unavailable";
  return undefined;
};

const requestReauthError: ErrorClassifier = (status, value) => {
  if (status === 401 && exact(value, ["authenticated"]) && value.authenticated === false) return "session";
  if ((status === 400 || status === 405) && exactError(value, "invalid_request")) return "unavailable";
  if (status === 503 && exactError(value, "unavailable")) return "unavailable";
  return undefined;
};

const verifyReauthError: ErrorClassifier = (status, value) => {
  // The server intentionally gives invalid OTP and invalid session the same response.
  if (status === 401 && exact(value, ["reauthenticated"]) && value.reauthenticated === false) return "unavailable";
  if ((status === 400 || status === 405) && exactError(value, "invalid_request")) return "unavailable";
  if (status === 503 && exactError(value, "unavailable")) return "unavailable";
  return undefined;
};

async function post(path: string, body: string, classifyError: ErrorClassifier, key?: string, externalSignal?: AbortSignal, timeout = 10_000) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    let response: Response;
    try {
      response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: headers(key),
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      throw new EligibilityMutationRequestError(aborted && timedOut ? "timeout" : "unavailable");
    }
    const correlation = response.headers.get("x-correlation-id") ?? undefined;
    if (correlation && !CORRELATION.test(correlation)) throw new EligibilityMutationRequestError("unavailable");
    const value = await bounded(response);
    if (!response.ok) throw new EligibilityMutationRequestError(classifyError(response.status, value) ?? "unavailable", correlation);
    return { value, correlation };
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validResult(value: unknown, mutation: EligibilityMutation): value is EligibilityResult {
  if (!plain(value) || value.studentId !== mutation.studentId) return false;
  const common = ["studentId", "eligibilityStatus", "eligibilityReviewedAt", "updatedAt"];
  const expectedStatus = mutation.decision === "reject" ? "rejected" : mutation.decision === "suspend" ? "suspended" : "approved";
  if (value.eligibilityStatus !== expectedStatus || !canonicalUtc(value.eligibilityReviewedAt) || !canonicalUtc(value.updatedAt)) return false;
  if (mutation.decision === "reject") {
    return exact(value, [...common, "rejectedAt"]) && canonicalUtc(value.rejectedAt);
  }
  if (mutation.decision === "suspend") {
    return exact(value, [...common, "approvedAt", "suspendedAt"]) && canonicalUtc(value.approvedAt) && canonicalUtc(value.suspendedAt);
  }
  return exact(value, [...common, "approvedAt"]) && canonicalUtc(value.approvedAt);
}

export async function submitEligibilityDecision(mutation: EligibilityMutation, key: string, signal?: AbortSignal) {
  if (!IDEMPOTENCY_KEY.test(key)) throw new EligibilityMutationRequestError("unavailable");
  const reason = canonicalizeEligibilityReason(mutation.decision, mutation.reasonCode, mutation.reason);
  if (reason !== mutation.reason || !UUID.test(mutation.studentId) || !canonicalUtc(mutation.expectedUpdatedAt)) {
    throw new EligibilityMutationRequestError("unavailable");
  }
  const { value, correlation } = await post("/api/downtown-u/operator/eligibility-decisions", JSON.stringify(mutation), eligibilityError, key, signal);
  if (!correlation || !exact(value, ["result", "replayed"]) || typeof value.replayed !== "boolean" || !validResult(value.result, mutation)) {
    throw new EligibilityMutationRequestError("unavailable");
  }
  return Object.freeze({ result: Object.freeze({ ...value.result }), replayed: value.replayed, correlationId: correlation });
}

export async function requestSmsReauth(signal?: AbortSignal) {
  const { value } = await post("/api/downtown-u/operator/auth/reauth/request", "{}", requestReauthError, undefined, signal);
  if (!exact(value, ["accepted", "challengeId"]) || value.accepted !== true || typeof value.challengeId !== "string" || !UUID.test(value.challengeId)) {
    throw new EligibilityMutationRequestError("unavailable");
  }
  return { accepted: true as const, challengeId: value.challengeId };
}

export async function verifySmsReauth(challengeId: string, otp: string, signal?: AbortSignal) {
  if (!UUID.test(challengeId) || !/^\d{6}$/.test(otp)) throw new EligibilityMutationRequestError("unavailable");
  const { value } = await post("/api/downtown-u/operator/auth/reauth/verify", JSON.stringify({ challengeId, otp }), verifyReauthError, undefined, signal);
  if (!exact(value, ["reauthenticated", "validForSeconds"]) || value.reauthenticated !== true || !Number.isSafeInteger(value.validForSeconds) || Number(value.validForSeconds) < 1 || Number(value.validForSeconds) > 3600) {
    throw new EligibilityMutationRequestError("unavailable");
  }
  return { reauthenticated: true as const, validForSeconds: value.validForSeconds as number };
}
