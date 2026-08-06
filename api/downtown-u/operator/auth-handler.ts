import { waitUntil } from "@vercel/functions";
import type { Pool } from "pg";
import { createOperatorAuthAdmissionGuard, type OperatorAuthAdmissionGuard } from "../../../server/downtown-u/operator/auth-admission";
import { operatorAuthCryptographyFromEnvironment } from "../../../server/downtown-u/operator/auth-crypto";
import { sendOperatorMagicLink, sendOperatorSmsOtp } from "../../../server/downtown-u/operator/auth-delivery";
import {
  OPERATOR_AUTH_RESPONSE_HEADERS,
  OperatorAuthBoundaryError,
  clearOperatorSessionCookie,
  parseOperatorAuthenticatedGet,
  parseOperatorPostRequest,
  parseOperatorPublicOrigin,
  parseOperatorSessionCookie,
  serializeOperatorSessionCookie,
  type OperatorAuthPostEndpoint,
  type OperatorRawRequest,
  type OperatorSessionCredential,
} from "../../../server/downtown-u/operator/auth-http";
import { OperatorAuthService, type OperatorAuthStore } from "../../../server/downtown-u/operator/auth-service";
import {
  PostgresOperatorAuthStore,
  getDowntownUOperatorPool,
  type OperatorAuthStore as PostgresStore,
} from "../../../server/downtown-u/operator/postgres-auth-store";

export type OperatorAuthEndpoint = OperatorAuthPostEndpoint | "session";
export type NodeOperatorAuthRequest = OperatorRawRequest;
export interface NodeOperatorAuthResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void; end?(): void };
}
export const operatorRawJsonConfig = Object.freeze({ api: Object.freeze({ bodyParser: false }) });

export interface OperatorAuthComposition {
  readonly service: Pick<OperatorAuthService,
    "requestLink" | "verifyEmail" | "verifySms" | "session" | "logout" | "requestReauth" | "verifyReauth">;
  readonly now?: () => Date;
}
export type OperatorAuthCompositionFactory = () => OperatorAuthComposition | Promise<OperatorAuthComposition>;

const ACCEPTED = Object.freeze({ accepted: true as const });
const AUTHENTICATION_FAILED = Object.freeze({ authenticated: false as const });
const REAUTHENTICATION_FAILED = Object.freeze({ reauthenticated: false as const });
const INVALID_REQUEST = Object.freeze({ error: "invalid_request" as const });
const UNAVAILABLE = Object.freeze({ error: "unavailable" as const });

function send(response: NodeOperatorAuthResponse, status: number, body?: unknown, cookie?: string): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(OPERATOR_AUTH_RESPONSE_HEADERS)) response.setHeader(name, value);
  if (cookie !== undefined) response.setHeader("Set-Cookie", cookie);
  const target = response.status(status);
  if (status === 204 && target.end) target.end(); else target.json(body ?? {});
}

function ownMethod(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(request, "method");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/** Called only after auth-http has validated the request's exact header representation. */
function validatedHeaders(request: NodeOperatorAuthRequest): Record<string, string> {
  const descriptor = Object.getOwnPropertyDescriptor(request, "headers");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null) {
    throw new OperatorAuthBoundaryError();
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(descriptor.value)) {
    const item = Object.getOwnPropertyDescriptor(descriptor.value, name);
    if (!item || !("value" in item) || typeof item.value !== "string") throw new OperatorAuthBoundaryError();
    result[name.toLowerCase()] = item.value;
  }
  return result;
}

function boundaryFailure(endpoint: OperatorAuthEndpoint, response: NodeOperatorAuthResponse, wrongMethod: boolean): void {
  const clear = endpoint === "logout" ? clearOperatorSessionCookie() : undefined;
  if (wrongMethod) { send(response, 405, INVALID_REQUEST, clear); return; }
  if (endpoint === "request-link") { send(response, 202, ACCEPTED); return; }
  if (endpoint === "logout") { send(response, 400, INVALID_REQUEST, clear); return; }
  if (endpoint === "reauth-verify") { send(response, 401, REAUTHENTICATION_FAILED); return; }
  send(response, 401, AUTHENTICATION_FAILED);
}

function unavailable(endpoint: OperatorAuthEndpoint, response: NodeOperatorAuthResponse): void {
  if (endpoint === "request-link") { send(response, 202, ACCEPTED); return; }
  send(response, 503, UNAVAILABLE, endpoint === "logout" ? clearOperatorSessionCookie() : undefined);
}

function credential(headers: Record<string, string>): OperatorSessionCredential | null {
  return parseOperatorSessionCookie(headers.cookie);
}

/**
 * Raw Node/Vercel adapter. Parsing and request-boundary decisions are delegated
 * to auth-http before the injected composition factory can touch providers/DB.
 */
export function createOperatorAuthHandler(
  endpoint: OperatorAuthEndpoint,
  configuredOrigin: string,
  compose: OperatorAuthCompositionFactory,
) {
  return async (request: NodeOperatorAuthRequest, response: NodeOperatorAuthResponse): Promise<void> => {
    const expectedMethod = endpoint === "session" ? "GET" : "POST";
    const method = ownMethod(request);
    if (method !== expectedMethod) {
      response.setHeader("Allow", expectedMethod);
      boundaryFailure(endpoint, response, true);
      return;
    }

    let body: Awaited<ReturnType<typeof parseOperatorPostRequest>> | undefined;
    let headers: Record<string, string>;
    try {
      if (endpoint === "session") await parseOperatorAuthenticatedGet(request, configuredOrigin);
      else body = await parseOperatorPostRequest(request, endpoint, configuredOrigin);
      headers = validatedHeaders(request);
    } catch {
      boundaryFailure(endpoint, response, false);
      return;
    }

    const sessionCredential = credential(headers);
    if ((endpoint === "session" || endpoint === "reauth-request" || endpoint === "reauth-verify") && sessionCredential === null) {
      boundaryFailure(endpoint, response, false);
      return;
    }

    let composition: OperatorAuthComposition;
    try { composition = await compose(); } catch { unavailable(endpoint, response); return; }

    try {
      if (endpoint === "request-link") {
        await composition.service.requestLink((body as { email: string }).email, headers);
        send(response, 202, ACCEPTED);
      } else if (endpoint === "verify-email") {
        const result = await composition.service.verifyEmail(body as { flowId: string; flowVerifier: string; challengeId: string; verifier: string }, headers);
        if ("mfaRequired" in result && result.mfaRequired === true && typeof result.smsChallengeId === "string") {
          send(response, 200, { mfaRequired: true, smsChallengeId: result.smsChallengeId });
        } else if ("unavailable" in result) unavailable(endpoint, response);
        else send(response, 401, AUTHENTICATION_FAILED);
      } else if (endpoint === "verify-sms") {
        const result = await composition.service.verifySms(body as { flowId: string; flowVerifier: string; challengeId: string; otp: string }, headers);
        if ("public" in result && result.public.authenticated === true) {
          const internal = result.cookie;
          const now = (composition.now ?? (() => new Date()))().getTime();
          const rawTtl = Math.floor((internal.absoluteExpiresAt.getTime() - now) / 1_000);
          if (!Number.isFinite(rawTtl) || rawTtl < 1) { send(response, 401, AUTHENTICATION_FAILED); return; }
          const ttl = Math.min(28_800, rawTtl);
          const setCookie = serializeOperatorSessionCookie(internal.sessionId, internal.bearer, ttl);
          send(response, 200, { authenticated: true,
            operator: { displayName: result.public.displayName, roles: [...result.public.roles] } }, setCookie);
        } else if ("unavailable" in result) unavailable(endpoint, response);
        else send(response, 401, AUTHENTICATION_FAILED);
      } else if (endpoint === "session") {
        const result = await composition.service.session(sessionCredential!);
        if ("unavailable" in result) unavailable(endpoint, response);
        else if (result.authenticated === true) send(response, 200, { authenticated: true,
          operator: { displayName: result.displayName, roles: [...result.roles] }, smsReauthFresh: result.smsReauthFresh });
        else send(response, 401, AUTHENTICATION_FAILED);
      } else if (endpoint === "logout") {
        const result = await composition.service.logout(sessionCredential);
        if ("unavailable" in result) unavailable(endpoint, response);
        else send(response, 204, undefined, clearOperatorSessionCookie());
      } else if (endpoint === "reauth-request") {
        const result = await composition.service.requestReauth(sessionCredential!, headers);
        if ("accepted" in result && result.accepted === true) send(response, 202, ACCEPTED);
        else if ("unavailable" in result) unavailable(endpoint, response);
        else send(response, 401, AUTHENTICATION_FAILED);
      } else {
        const result = await composition.service.verifyReauth(sessionCredential!, body as { challengeId: string; otp: string }, headers);
        if ("unavailable" in result) unavailable(endpoint, response);
        else if (result.reauthenticated === true) send(response, 200, { reauthenticated: true, validForSeconds: 300 });
        else send(response, 401, REAUTHENTICATION_FAILED);
      }
    } catch {
      unavailable(endpoint, response);
    }
  };
}

export interface ProductionOperatorAuthBoundaries {
  readonly getPool: (env: NodeJS.ProcessEnv) => Pool;
  readonly createStore: (pool: Pool) => OperatorAuthStore;
  readonly createAdmission: (env: NodeJS.ProcessEnv) => OperatorAuthAdmissionGuard;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Keeps the concrete store behind the service's narrow capability interface. */
function adaptPostgresStore(store: PostgresStore): OperatorAuthStore {
  const adapted: OperatorAuthStore = {
    begin: (input) => store.begin(input),
    verifyEmail: (input) => store.verifyEmail(input),
    finishSignIn: (input) => store.finishSignIn(input),
    validateSession: (input) => store.validateSession(input as Parameters<PostgresStore["validateSession"]>[0]),
    beginReauth: (input) => store.beginReauth(input),
    finishReauth: (input) => store.finishReauth(input),
    revoke: (input) => store.revoke(input),
  };
  return Object.freeze(adapted);
}

const productionBoundaryValues: ProductionOperatorAuthBoundaries = {
  getPool: getDowntownUOperatorPool,
  createStore: (pool: Pool) => adaptPostgresStore(new PostgresOperatorAuthStore(pool)),
  createAdmission: createOperatorAuthAdmissionGuard,
  waitUntil,
};
const productionBoundaries: ProductionOperatorAuthBoundaries = Object.freeze(productionBoundaryValues);

function productionComposition(endpoint: OperatorAuthEndpoint, env: NodeJS.ProcessEnv,
  boundaries: ProductionOperatorAuthBoundaries): OperatorAuthComposition {
  if (env.DOWNTOWN_U_OPERATOR_ENABLED !== "1") throw new Error("unavailable");
  const publicOrigin = parseOperatorPublicOrigin(env.DOWNTOWN_U_PUBLIC_APP_ORIGIN);
  // No DATABASE_URL fallback: the dedicated factory reads only DOWNTOWN_U_OPERATOR_DATABASE_URL.
  const store = boundaries.createStore(boundaries.getPool(env));
  const cryptography = operatorAuthCryptographyFromEnvironment(env);
  const needsAdmission = endpoint === "request-link" || endpoint === "verify-email" || endpoint === "verify-sms"
    || endpoint === "reauth-request" || endpoint === "reauth-verify";
  const admission = needsAdmission ? boundaries.createAdmission(env) : Object.freeze({
    admitRequestLink: async () => false, admitEmailVerification: async () => false,
    admitSmsVerification: async () => false, admitReauthIssuance: async () => false,
    admitReauthVerification: async () => false,
  });
  const delivery = Object.freeze({
    sendMagicLink: endpoint === "request-link"
      ? (input: Parameters<typeof sendOperatorMagicLink>[0]) => sendOperatorMagicLink(input, { env })
      : async () => { throw new Error("unavailable"); },
    sendSmsOtp: endpoint === "verify-email" || endpoint === "reauth-request"
      ? (input: Parameters<typeof sendOperatorSmsOtp>[0]) => sendOperatorSmsOtp(input, { env })
      : async () => { throw new Error("unavailable"); },
  });
  return { service: new OperatorAuthService({ store, cryptography, admission, delivery, publicOrigin,
    waitUntil: boundaries.waitUntil, clock: () => new Date() }), now: () => new Date() };
}

/** Import-safe production wrapper: environment and every external dependency are read only inside a request. */
export function createProductionOperatorAuthHandler(
  endpoint: OperatorAuthEndpoint,
  environment: () => NodeJS.ProcessEnv = () => process.env,
  boundaries: ProductionOperatorAuthBoundaries = productionBoundaries,
) {
  return async (request: NodeOperatorAuthRequest, response: NodeOperatorAuthResponse): Promise<void> => {
    const expectedMethod = endpoint === "session" ? "GET" : "POST";
    if (ownMethod(request) !== expectedMethod) {
      response.setHeader("Allow", expectedMethod);
      boundaryFailure(endpoint, response, true);
      return;
    }
    const env = environment();
    let origin: string;
    try { origin = parseOperatorPublicOrigin(env.DOWNTOWN_U_PUBLIC_APP_ORIGIN); }
    catch { unavailable(endpoint, response); return; }
    return createOperatorAuthHandler(endpoint, origin, () => productionComposition(endpoint, env, boundaries))(request, response);
  };
}
