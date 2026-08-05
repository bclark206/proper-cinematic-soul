import { isUint8Array } from "node:util/types";
import { waitUntil } from "@vercel/functions";
import { Pool, type PoolConfig } from "pg";
import { createAuthRequestAdmissionGuard, type AuthRequestAdmissionGuard } from "../../server/downtown-u/auth-admission";
import {
  createEmailAuthDeliveryFromEnvironment, createSmsAuthDeliveryFromEnvironment,
} from "../../server/downtown-u/auth-delivery";
import {
  AUTH_HTTP_MAX_BODY_BYTES, authInvariantHeaders, authProtocolResponse, createAuthHttpHandler, malformedJsonResponse, oversizedResponse,
  type AuthBackgroundScheduler, type AuthEndpoint, type AuthHttpRequest, type AuthHttpResponse,
} from "../../server/downtown-u/auth-http";
import { createDowntownUAuthService, type DowntownUAuthService } from "../../server/downtown-u/auth-service";
import { PostgresAuthStore, type AuthStore } from "../../server/downtown-u/postgres-auth-store";

export type NodeAuthRequest = AsyncIterable<unknown> & {
  method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; readableEnded?: boolean;
};
export type NodeAuthResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void; end?(): void };
};
export const rawJsonConfig = { api: { bodyParser: false } };

function send(response: NodeAuthResponse, result: AuthHttpResponse): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  const target = response.status(result.status);
  if (result.body === undefined && target.end) target.end(); else target.json(result.body ?? {});
}
function hasUnsafePreparsedBody(request: NodeAuthRequest): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(request, "body");
  if (descriptor && (!("value" in descriptor) || descriptor.value !== undefined)) return true;
  const ended = Object.getOwnPropertyDescriptor(request, "readableEnded");
  // Accessors are never invoked. An accessor cannot prove that the stream is pristine,
  // so the production adapter fails closed just as it does for an ended stream.
  return ended !== undefined && (!("value" in ended) || ended.value === true);
}
async function readBody(request: NodeAuthRequest): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0;
  // Exiting a for-await loop invokes iterator.return(); Node Readable's iterator
  // destroys the stream, so an oversized body is cancelled without draining it.
  for await (const chunk of request) {
    if (!isUint8Array(chunk)) throw new TypeError("non-byte body");
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    size += bytes.byteLength;
    if (size > AUTH_HTTP_MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export function createNodeAuthHandler(endpoint: AuthEndpoint, service: Pick<DowntownUAuthService, "request" | "verify">,
  allowedOrigin: string, admissionGuard: AuthRequestAdmissionGuard, scheduler: AuthBackgroundScheduler) {
  const core = createAuthHttpHandler({ endpoint, service, allowedOrigin, admissionGuard, scheduler });
  return async (request: NodeAuthRequest, response: NodeAuthResponse): Promise<void> => {
    const protocolResponse = authProtocolResponse({ method: request.method, headers: request.headers }, allowedOrigin);
    if (protocolResponse) { send(response, protocolResponse); return; }
    const invariantHeaders = authInvariantHeaders({ headers: request.headers }, allowedOrigin);
    if (hasUnsafePreparsedBody(request)) { send(response, malformedJsonResponse(endpoint, invariantHeaders)); return; }
    let raw: Buffer | null;
    try { raw = await readBody(request); } catch { send(response, malformedJsonResponse(endpoint, invariantHeaders)); return; }
    if (raw === null) { send(response, oversizedResponse(endpoint, invariantHeaders)); return; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { send(response, malformedJsonResponse(endpoint, invariantHeaders)); return; }
    send(response, await core({ method: request.method, headers: request.headers, body }));
  };
}

function canonicalPostgresConnectionString(connectionString: string): string {
  let parsed: URL;
  try { parsed = new URL(connectionString); } catch { throw new Error("invalid database configuration"); }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || !parsed.hostname || !parsed.username || parsed.hash) throw new Error("invalid database configuration");
  return parsed.toString();
}

/** A cache is scoped by canonical database identity; credentials are never exposed as a public key or error. */
export function createAuthPoolCache(
  createPool: (config: PoolConfig) => Pool = (config) => new Pool(config),
): (connectionString: string) => Pool {
  const pools = new Map<string, Pool>();
  return (connectionString: string): Pool => {
    const canonical = canonicalPostgresConnectionString(connectionString);
    const existing = pools.get(canonical);
    if (existing) return existing;
    const pool = createPool({ connectionString: canonical, max: 5, idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000, allowExitOnIdle: true });
    pools.set(canonical, pool);
    return pool;
  };
}
const getAuthPool = createAuthPoolCache();
export interface ProductionAuthBoundaries {
  getPool(connectionString: string): Pool;
  createStore(pool: Pool): AuthStore;
  createService(store: AuthStore, env: NodeJS.ProcessEnv, endpoint: AuthEndpoint): DowntownUAuthService;
  createAdmissionGuard(env: NodeJS.ProcessEnv): AuthRequestAdmissionGuard;
  scheduler: AuthBackgroundScheduler;
}
export function createProductionAuthService(
  store: AuthStore, env: NodeJS.ProcessEnv, endpoint: AuthEndpoint,
): DowntownUAuthService {
  if (endpoint === "request-link") {
    return createDowntownUAuthService(store, env.DOWNTOWN_U_AUTH_SECRET,
      createEmailAuthDeliveryFromEnvironment(env), observeBackgroundError);
  }
  if (endpoint === "send-code") {
    return createDowntownUAuthService(store, env.DOWNTOWN_U_AUTH_SECRET,
      createSmsAuthDeliveryFromEnvironment(env), observeBackgroundError);
  }
  // Verification has no delivery/provider dependency at all.
  return createDowntownUAuthService(store, env.DOWNTOWN_U_AUTH_SECRET);
}
function observeBackgroundError(): void { console.error("Authentication background request failed"); }

export function createVercelBackgroundScheduler(
  waitUntilImpl: (promise: Promise<unknown>) => void = waitUntil,
): AuthBackgroundScheduler {
  return Object.freeze({
    schedule(work: () => Promise<void>): void {
      const promise = Promise.resolve().then(work).catch(observeBackgroundError);
      waitUntilImpl(promise);
    },
  });
}
const productionBoundaries: ProductionAuthBoundaries = {
  getPool: getAuthPool,
  createStore: (pool) => new PostgresAuthStore(pool),
  createService: createProductionAuthService,
  createAdmissionGuard: (env) => createAuthRequestAdmissionGuard(env),
  scheduler: createVercelBackgroundScheduler(),
};
function allowedOrigin(env: NodeJS.ProcessEnv): string {
  const value = env.DOWNTOWN_U_PUBLIC_APP_ORIGIN;
  if (!value) throw new Error("configuration");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.pathname !== "/") throw new Error("configuration");
  return parsed.origin;
}

/** Lazy, fail-closed production composition. Importing an endpoint never reads credentials. */
export function createProductionAuthHandler(endpoint: AuthEndpoint, env: NodeJS.ProcessEnv,
  boundaries: ProductionAuthBoundaries = productionBoundaries) {
  let handler: ReturnType<typeof createNodeAuthHandler> | undefined;
  return async (request: NodeAuthRequest, response: NodeAuthResponse): Promise<void> => {
    if (!handler) {
      let origin = "https://invalid.invalid";
      try {
        origin = allowedOrigin(env);
        if (!env.DATABASE_URL) throw new Error("configuration");
        // Request endpoints must establish external admission before composing any
        // challenge/delivery service. Verification never instantiates the guard.
        const admissionGuard = endpoint === "verify-code"
          ? Object.freeze({ admit: async () => false }) : boundaries.createAdmissionGuard(env);
        const store = boundaries.createStore(boundaries.getPool(env.DATABASE_URL));
        handler = createNodeAuthHandler(endpoint, boundaries.createService(store, env, endpoint), origin,
          admissionGuard, boundaries.scheduler);
      } catch {
        const unavailable = {
          request: async () => ({ accepted: true as const }),
          verify: async () => { throw new Error("unavailable"); },
        };
        // Preserve a validated first-party origin while keeping all missing credentials fail-closed.
        handler = createNodeAuthHandler(endpoint, unavailable, origin,
          Object.freeze({ admit: async () => false }), boundaries.scheduler);
      }
    }
    await handler(request, response);
  };
}

export function asCoreRequest(method: string, headers: AuthHttpRequest["headers"], body: unknown): AuthHttpRequest {
  return { method, headers, body };
}
