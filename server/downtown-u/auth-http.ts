import { AUTH_SESSION_TTL_SECONDS } from "./auth";
import type { AuthRequestAdmissionGuard } from "./auth-admission";
import { AUTH_REQUEST_ACCEPTED, type DowntownUAuthService } from "./auth-service";

export const AUTH_HTTP_MAX_BODY_BYTES = 4_096;
export const AUTH_SESSION_COOKIE = "downtown_u_session";
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const OTP = /^\d{6}$/;
const ACCEPTED = Object.freeze({ accepted: true });
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export interface AuthHttpRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
export interface AuthHttpResponse { status: number; body?: unknown; headers: Record<string, string> }
export type AuthEndpoint = "request-link" | "send-code" | "verify-code";
export interface AuthBackgroundScheduler { schedule(work: () => Promise<void>): void }

function header(headers: AuthHttpRequest["headers"], name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(headers, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
function response(status: number, body?: unknown, extra: Record<string, string> = {}): AuthHttpResponse {
  return { status, ...(body === undefined ? {} : { body }), headers: { ...SECURITY_HEADERS, ...extra } };
}
function ownPlainData(body: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== names.length || names.some((name) => !keys.includes(name))) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(body, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    result[name] = descriptor.value;
  }
  return result;
}
function originAllowed(request: AuthHttpRequest, allowedOrigin: string): boolean {
  const fetchSite = header(request.headers, "sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  const origin = header(request.headers, "origin");
  return origin === undefined || origin === allowedOrigin;
}
function corsHeaders(request: AuthHttpRequest, allowedOrigin: string): Record<string, string> {
  return header(request.headers, "origin") === allowedOrigin
    ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {};
}
/** CORS headers known safe after authProtocolResponse has accepted the request. */
export function authInvariantHeaders(request: AuthHttpRequest, allowedOrigin: string): Record<string, string> {
  return corsHeaders(request, allowedOrigin);
}
function jsonContentType(request: AuthHttpRequest): boolean {
  const value = header(request.headers, "content-type");
  return value !== undefined && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}
/** Performs mutation protocol checks without consuming a request body. */
export function authProtocolResponse(request: AuthHttpRequest, allowedOrigin: string): AuthHttpResponse | undefined {
  const cors = corsHeaders(request, allowedOrigin);
  if (!originAllowed(request, allowedOrigin)) return response(403, { error: "forbidden" });
  if (request.method === "OPTIONS") return response(204, undefined, {
    ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  });
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" }, { ...cors, Allow: "POST, OPTIONS" });
  if (!jsonContentType(request)) return response(415, { error: "unsupported_media_type" }, cors);
  return undefined;
}
function cookieValue(sessionId: string, bearerToken: string, maxAge: number): string {
  if (!OPAQUE.test(sessionId) || !OPAQUE.test(bearerToken) || !Number.isSafeInteger(maxAge) || maxAge < 1) throw new Error("invalid credential");
  return `${AUTH_SESSION_COOKIE}=v1.${sessionId}.${bearerToken}; Max-Age=${maxAge}; Path=/api/downtown-u; HttpOnly; Secure; SameSite=Strict`;
}

export function createAuthHttpHandler(config: {
  endpoint: AuthEndpoint; service: Pick<DowntownUAuthService, "request" | "verify">; allowedOrigin: string;
  admissionGuard: AuthRequestAdmissionGuard; scheduler: AuthBackgroundScheduler;
  observeBackgroundError?: () => void; now?: () => Date;
}) {
  const now = config.now ?? (() => new Date());
  return async (request: AuthHttpRequest): Promise<AuthHttpResponse> => {
    const cors = corsHeaders(request, config.allowedOrigin);
    const protocolResponse = authProtocolResponse(request, config.allowedOrigin);
    if (protocolResponse) return protocolResponse;

    if (config.endpoint === "request-link") {
      const body = ownPlainData(request.body, ["email"]);
      if (body && typeof body.email === "string") {
        let admitted = false;
        try { admitted = await config.admissionGuard.admit(request.headers); } catch { /* fail closed */ }
        if (admitted) scheduleRequest(config, "email", body.email);
      }
      return response(202, ACCEPTED, cors);
    }
    if (config.endpoint === "send-code") {
      const body = ownPlainData(request.body, ["phone"]);
      if (body && typeof body.phone === "string") {
        let admitted = false;
        try { admitted = await config.admissionGuard.admit(request.headers); } catch { /* fail closed */ }
        if (admitted) scheduleRequest(config, "phone", body.phone);
      }
      return response(202, ACCEPTED, cors);
    }

    const body = ownPlainData(request.body, ["challengeId", "verifier"]);
    if (!body || typeof body.challengeId !== "string" || typeof body.verifier !== "string"
      || !OPAQUE.test(body.challengeId) || !(OPAQUE.test(body.verifier) || OTP.test(body.verifier))) {
      return response(401, { authenticated: false }, cors);
    }
    try {
      const result = await config.service.verify(body.challengeId, body.verifier);
      if (result.outcome !== "authenticated") return response(401, { authenticated: false }, cors);
      if (!(result.expiresAt instanceof Date)) return response(401, { authenticated: false }, cors);
      const expiresAt = result.expiresAt.getTime();
      const currentTime = now().getTime();
      if (!Number.isFinite(expiresAt) || !Number.isFinite(currentTime)) return response(401, { authenticated: false }, cors);
      const wholeSeconds = Math.floor((expiresAt - currentTime) / 1_000);
      if (!Number.isSafeInteger(wholeSeconds) || wholeSeconds < 1) return response(401, { authenticated: false }, cors);
      const ttl = Math.min(AUTH_SESSION_TTL_SECONDS, wholeSeconds);
      const cookie = cookieValue(result.sessionId, result.bearerToken, ttl);
      return response(200, { authenticated: true }, { ...cors, "Set-Cookie": cookie });
    } catch {
      return response(401, { authenticated: false }, cors);
    }
  };
}

function scheduleRequest(config: {
  service: Pick<DowntownUAuthService, "request">; scheduler: AuthBackgroundScheduler;
  observeBackgroundError?: () => void;
}, contactType: "email" | "phone", contact: string): void {
  // Arm only after the scheduler accepts the callback. Even a synchronous
  // scheduler failure cannot create a challenge or invoke a provider.
  let armed = false;
  const work = async (): Promise<void> => {
    await Promise.resolve();
    if (!armed) return;
    try { await config.service.request(contactType, contact); }
    catch {
      // The observer receives no original error, contact, actor, or credential.
      try { config.observeBackgroundError?.(); } catch { /* diagnostics are isolated */ }
    }
  };
  try { config.scheduler.schedule(work); armed = true; }
  catch { armed = false; }
}

/** Used by raw adapters when JSON parsing fails; request endpoints remain enumeration-invariant. */
export function malformedJsonResponse(endpoint: AuthEndpoint, headers: Record<string, string> = {}): AuthHttpResponse {
  return endpoint === "verify-code" ? response(401, { authenticated: false }, headers) : response(202, AUTH_REQUEST_ACCEPTED, headers);
}
export function oversizedResponse(endpoint: AuthEndpoint, headers: Record<string, string> = {}): AuthHttpResponse {
  return endpoint === "verify-code" ? response(401, { authenticated: false }, headers) : response(202, AUTH_REQUEST_ACCEPTED, headers);
}
