import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  operatorAuthCryptographyFromEnvironment,
  type OperatorAuthCryptography,
} from "../../../server/downtown-u/operator/auth-crypto";
import {
  OperatorAuthBoundaryError,
  OPERATOR_AUTH_RESPONSE_HEADERS,
  parseOperatorAuthenticatedGet,
  parseOperatorPublicOrigin,
  parseOperatorSessionCookie,
  type OperatorRawRequest,
} from "../../../server/downtown-u/operator/auth-http";
import {
  getDowntownUOperatorPool,
  operatorDatabasePoolConfig,
} from "../../../server/downtown-u/operator/postgres-auth-store";
import {
  PostgresOperatorReadStore,
  type OperatorReadStore,
} from "../../../server/downtown-u/operator/postgres-read-store";
import {
  createReadCursorCodec,
  OperatorReadCursorError,
} from "../../../server/downtown-u/operator/read-cursor";
import { parseOperatorReadQuery } from "../../../server/downtown-u/operator/read-http";
import {
  validateReadItems,
  type OperatorReadEndpoint,
} from "../../../server/downtown-u/operator/read-types";

export interface NodeOperatorReadRequest extends OperatorRawRequest { url?: unknown }
export interface NodeOperatorReadResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}
export const operatorReadRawConfig = Object.freeze({ api: Object.freeze({ bodyParser: false }) });
export interface OperatorReadComposition {
  store: OperatorReadStore;
  cryptography: Pick<OperatorAuthCryptography, "digestSession" | "digestReadCursor">;
}
export type OperatorReadCompositionFactory = () => OperatorReadComposition | Promise<OperatorReadComposition>;

const bodies = {
  methodNotAllowed: Object.freeze({ error: "method_not_allowed" }),
  invalidRequest: Object.freeze({ error: "invalid_request" }),
  unauthorized: Object.freeze({ error: "unauthorized" }),
  forbidden: Object.freeze({ error: "forbidden" }),
  unavailable: Object.freeze({ error: "unavailable" }),
} as const;

function send(response: NodeOperatorReadResponse, status: number, body: unknown): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(OPERATOR_AUTH_RESPONSE_HEADERS)) response.setHeader(name, value);
  response.status(status).json(body);
}
function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
function requestMethod(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "method");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch { return null; }
}
function header(request: unknown, name: string): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(request, "headers");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null) return undefined;
  for (const key of Object.keys(descriptor.value)) {
    if (key.toLowerCase() !== name) continue;
    const value = Object.getOwnPropertyDescriptor(descriptor.value, key);
    return value && "value" in value && typeof value.value === "string" ? value.value : undefined;
  }
  return undefined;
}
/** Classify definitely foreign metadata before strict duplicate-header validation. */
function crossOrigin(request: unknown, origin: string): boolean {
  const supplied = header(request, "origin");
  const fetchSite = header(request, "sec-fetch-site");
  if ((supplied !== undefined && supplied !== origin) || (fetchSite !== undefined && fetchSite !== "same-origin")) return true;
  if (typeof request !== "object" || request === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(request, "rawHeaders");
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) return false;
    for (let index = 0; index < descriptor.value.length; index += 2) {
      const key = descriptor.value[index];
      const value = descriptor.value[index + 1];
      if (typeof key === "string" && key.toLowerCase() === "origin" && value !== origin) return true;
      if (typeof key === "string" && key.toLowerCase() === "sec-fetch-site" && value !== "same-origin") return true;
    }
  } catch { return false; }
  return false;
}

export function createOperatorReadHandler(
  endpoint: OperatorReadEndpoint,
  configuredOrigin: string,
  compose: OperatorReadCompositionFactory,
) {
  return async (request: NodeOperatorReadRequest, response: NodeOperatorReadResponse): Promise<void> => {
    const method = requestMethod(request);
    if (method === null) { send(response, 400, bodies.invalidRequest); return; }
    if (method !== "GET") {
      response.setHeader("Allow", "GET");
      send(response, 405, bodies.methodNotAllowed);
      return;
    }
    try {
      if (crossOrigin(request, configuredOrigin)) { send(response, 403, bodies.forbidden); return; }
    } catch { send(response, 400, bodies.invalidRequest); return; }

    let query: ReturnType<typeof parseOperatorReadQuery>;
    try {
      await parseOperatorAuthenticatedGet(request, configuredOrigin);
      query = parseOperatorReadQuery(endpoint, ownString(request, "url"));
    } catch (error) {
      if (error instanceof OperatorAuthBoundaryError && error.code === "forbidden") send(response, 403, bodies.forbidden);
      else send(response, 400, bodies.invalidRequest);
      return;
    }

    let credential: ReturnType<typeof parseOperatorSessionCookie>;
    try { credential = parseOperatorSessionCookie(header(request, "cookie")); }
    catch { send(response, 400, bodies.invalidRequest); return; }
    if (!credential) { send(response, 401, bodies.unauthorized); return; }

    let composition: OperatorReadComposition;
    try { composition = await compose(); }
    catch { send(response, 503, bodies.unavailable); return; }

    try {
      const codec = createReadCursorCodec(composition.cryptography);
      let cursor: ReturnType<typeof codec.decode> | null = null;
      if (query.cursor !== null) {
        try { cursor = codec.decode(query.cursor, endpoint, query.filters, credential.sessionId); }
        catch (error) {
          if (error instanceof OperatorReadCursorError) send(response, 400, bodies.invalidRequest);
          else send(response, 503, bodies.unavailable);
          return;
        }
      }
      const sessionDigest = composition.cryptography.digestSession(credential.sessionId, credential.bearer);
      const result = await composition.store.read({
        endpoint,
        sessionId: credential.sessionId,
        sessionDigest,
        correlationId: `operator-dashboard:${randomUUID()}`,
        requestedLimit: query.limit + 1,
        cursor,
        filters: query.filters,
      });
      if (result.outcome === "invalid") { send(response, 401, bodies.unauthorized); return; }
      if (result.outcome === "denied") { send(response, 403, bodies.forbidden); return; }
      if (result.outcome !== "authorized") throw new Error("Invalid read outcome");

      const items = [...validateReadItems(endpoint, result.items)];
      if (items.length > query.limit + 1) throw new Error("Oversized pagination result");
      const hasNext = items.length > query.limit;
      if (hasNext) items.pop();
      let nextCursor: string | null = null;
      if (hasNext) {
        const last = items[items.length - 1];
        if (!last) throw new Error("Invalid pagination result");
        const timestamp = endpoint === "reconciliation" ? last.openedAt : last.createdAt;
        if (typeof timestamp !== "string" || typeof last.id !== "string") throw new Error("Invalid pagination result");
        nextCursor = codec.encode(endpoint, query.filters, credential.sessionId, timestamp, last.id);
      }
      send(response, 200, { items, nextCursor });
    } catch {
      send(response, 503, bodies.unavailable);
    }
  };
}

export interface ProductionOperatorReadBoundaries {
  getPool: (env: NodeJS.ProcessEnv) => Pool;
  createStore: (pool: Pool) => OperatorReadStore;
}
const productionBoundaries: ProductionOperatorReadBoundaries = Object.freeze({
  getPool: getDowntownUOperatorPool,
  createStore: (pool: Pool) => new PostgresOperatorReadStore(pool),
});
export function createProductionOperatorReadHandler(
  endpoint: OperatorReadEndpoint,
  environment: () => NodeJS.ProcessEnv = () => process.env,
  boundaries: ProductionOperatorReadBoundaries = productionBoundaries,
) {
  return async (request: NodeOperatorReadRequest, response: NodeOperatorReadResponse): Promise<void> => {
    const method = requestMethod(request);
    if (method === null) { send(response, 400, bodies.invalidRequest); return; }
    if (method !== "GET") {
      response.setHeader("Allow", "GET");
      send(response, 405, bodies.methodNotAllowed);
      return;
    }
    let env: NodeJS.ProcessEnv;
    try { env = environment(); }
    catch { send(response, 503, bodies.unavailable); return; }
    let origin: string;
    try { origin = parseOperatorPublicOrigin(env.DOWNTOWN_U_PUBLIC_APP_ORIGIN); }
    catch { send(response, 503, bodies.unavailable); return; }
    return createOperatorReadHandler(endpoint, origin, () => {
      if (env.DOWNTOWN_U_OPERATOR_ENABLED !== "1") throw new Error("Disabled");
      const cryptography = operatorAuthCryptographyFromEnvironment(env);
      // Validate before crossing the pool boundary so bad dedicated credentials
      // cannot construct a pool or fall back to an unrelated database URL.
      operatorDatabasePoolConfig(env);
      const store = boundaries.createStore(boundaries.getPool(env));
      return { store, cryptography };
    })(request, response);
  };
}
