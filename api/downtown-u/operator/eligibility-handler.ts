import { randomUUID as nodeRandomUUID } from "node:crypto";
import { types } from "node:util";
import type { Pool } from "pg";
import { createOperatorEligibilityAdmission, type OperatorEligibilityAdmission } from "../../../server/downtown-u/operator/eligibility-admission";
import { operatorAuthCryptographyFromEnvironment, type OperatorAuthCryptography } from "../../../server/downtown-u/operator/auth-crypto";
import { OPERATOR_AUTH_RESPONSE_HEADERS, parseOperatorPublicOrigin } from "../../../server/downtown-u/operator/auth-http";
import { OperatorEligibilityBoundaryError, parseOperatorEligibilityMutationRequest, type OperatorEligibilityRawRequest, type ParsedOperatorEligibilityMutation } from "../../../server/downtown-u/operator/eligibility-http";
import { validateEligibilityMutationItem } from "../../../server/downtown-u/operator/eligibility-types";
import { getDowntownUOperatorPool, operatorDatabasePoolConfig } from "../../../server/downtown-u/operator/postgres-auth-store";
import { PostgresOperatorEligibilityStore, type OperatorEligibilityMutationResult, type OperatorEligibilityStore } from "../../../server/downtown-u/operator/postgres-eligibility-store";
import { exactOwnData } from "../../../server/downtown-u/operator/trusted-result";

export type NodeOperatorEligibilityRequest = OperatorEligibilityRawRequest;
export interface NodeOperatorEligibilityResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}
export interface OperatorEligibilityComposition {
  store: OperatorEligibilityStore;
  admission: OperatorEligibilityAdmission;
  cryptography: Pick<OperatorAuthCryptography, "digestSession">;
}
export type OperatorEligibilityCompositionFactory = () => OperatorEligibilityComposition | Promise<OperatorEligibilityComposition>;
export const operatorEligibilityRawConfig = Object.freeze({ api: Object.freeze({ bodyParser: false }) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = {
  method: Object.freeze({ error: "method_not_allowed" }), invalid: Object.freeze({ error: "invalid_request" }),
  unauthorized: Object.freeze({ error: "unauthorized" }), forbidden: Object.freeze({ error: "forbidden" }),
  unavailable: Object.freeze({ error: "unavailable" }), limited: Object.freeze({ error: "rate_limited" }),
  reauth: Object.freeze({ error: "reauth_required" }), notFound: Object.freeze({ error: "not_found" }),
  stale: Object.freeze({ error: "stale_state" }), conflict: Object.freeze({ error: "conflict" }),
  idempotency: Object.freeze({ error: "idempotency_conflict" }),
} as const;
function method(request: unknown): string | null {
  try {
    if (typeof request !== "object" || request === null || types.isProxy(request) || Array.isArray(request)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(request, "method");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null;
  } catch { return null; }
}
function send(response: NodeOperatorEligibilityResponse, status: number, body: unknown, correlationId?: string): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(OPERATOR_AUTH_RESPONSE_HEADERS)) response.setHeader(name, value);
  if (correlationId) response.setHeader("X-Correlation-ID", correlationId);
  response.status(status).json(body);
}
function claimedOrigin(request: unknown): string | undefined {
  try {
    if (typeof request !== "object" || request === null || types.isProxy(request)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(request, "headers");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null || types.isProxy(descriptor.value)) return undefined;
    let result: string | undefined;
    for (const key of Object.keys(descriptor.value)) {
      if (key.toLowerCase() !== "origin") continue;
      if (result !== undefined) return undefined;
      const item = Object.getOwnPropertyDescriptor(descriptor.value, key);
      if (!item || !("value" in item) || typeof item.value !== "string") return undefined;
      result = item.value;
    }
    return result;
  } catch { return undefined; }
}
function boundaryError(response: NodeOperatorEligibilityResponse, error: unknown): void {
  if (error instanceof OperatorEligibilityBoundaryError && error.code === "forbidden") send(response, 403, errors.forbidden);
  else if (error instanceof OperatorEligibilityBoundaryError && error.code === "unauthorized") send(response, 401, errors.unauthorized);
  else send(response, 400, errors.invalid);
}
function validIds(values: readonly string[]): boolean { return values.every((value) => UUID.test(value)) && new Set(values).size === values.length; }
function admissionOutcome(value: unknown): "admitted" | "limited" | "unavailable" | undefined {
  const data = exactOwnData(value, ["outcome"]);
  return data && ["admitted", "limited", "unavailable"].includes(String(data.outcome))
    ? data.outcome as "admitted" | "limited" | "unavailable" : undefined;
}
async function execute(parsed: ParsedOperatorEligibilityMutation, origin: string, response: NodeOperatorEligibilityResponse,
  compose: OperatorEligibilityCompositionFactory, uuid: () => string): Promise<void> {
  let correlationId: string | undefined;
  try {
    const correlationUuid = uuid(); if (!validIds([correlationUuid])) throw new Error("invalid entropy");
    correlationId = `operator-mutation:${correlationUuid}`;
    const composition = await compose();
    const admission = admissionOutcome(await composition.admission.admit({ sessionId: parsed.credential.sessionId,
      targetId: parsed.body.studentId, origin, secFetchSite: "same-origin", correlationId }));
    if (admission === "limited") { send(response, 429, errors.limited, correlationId); return; }
    if (admission !== "admitted") { send(response, 503, errors.unavailable, correlationId); return; }
    const generated = [uuid(), uuid()]; if (!validIds([correlationUuid, ...generated])) throw new Error("invalid entropy");
    const digest = composition.cryptography.digestSession(parsed.credential.sessionId, parsed.credential.bearer);
    const result = await composition.store.mutate({ sessionId: parsed.credential.sessionId, sessionVersion: 1,
      sessionDigest: Buffer.from(digest), correlationId, idempotencyKey: parsed.idempotencyKey,
      auditId: generated[0], eventId: generated[1], ...parsed.body });
    respondToResult(response, result, correlationId);
  } catch { send(response, 503, errors.unavailable, correlationId); }
}
function respondToResult(response: NodeOperatorEligibilityResponse, result: OperatorEligibilityMutationResult, correlationId: string): void {
  const trusted = exactOwnData(result, ["outcome", "replayed", "item"]);
  if (!trusted || typeof trusted.outcome !== "string" || typeof trusted.replayed !== "boolean") throw new Error("hostile result");
  if (trusted.outcome === "updated") {
    const item = validateEligibilityMutationItem(trusted.item);
    send(response, 200, { result: item, replayed: trusted.replayed }, correlationId); return;
  }
  const mapping: Record<string, readonly [number, unknown]> = {
    invalid: [401, errors.unauthorized], denied: [403, errors.forbidden], reauth_required: [428, errors.reauth],
    not_found: [404, errors.notFound], stale_state: [409, errors.stale], conflict: [409, errors.conflict],
    idempotency_conflict: [409, errors.idempotency],
  };
  const mapped = mapping[trusted.outcome]; if (!mapped || trusted.item !== null || trusted.replayed !== false) throw new Error("hostile result");
  send(response, mapped[0], mapped[1], correlationId);
}
export function createOperatorEligibilityHandler(configuredOrigin: string, compose: OperatorEligibilityCompositionFactory,
  dependencies: { randomUUID: () => string } = { randomUUID: nodeRandomUUID }) {
  return async (request: NodeOperatorEligibilityRequest, response: NodeOperatorEligibilityResponse): Promise<void> => {
    const requestMethod = method(request);
    if (requestMethod === null) { send(response, 400, errors.invalid); return; }
    if (requestMethod !== "POST") { response.setHeader("Allow", "POST"); send(response, 405, errors.method); return; }
    let parsed: ParsedOperatorEligibilityMutation;
    try { parsed = await parseOperatorEligibilityMutationRequest(request, configuredOrigin); }
    catch (error) { boundaryError(response, error); return; }
    await execute(parsed, configuredOrigin, response, compose, dependencies.randomUUID);
  };
}

export interface ProductionOperatorEligibilityBoundaries {
  getPool(env: NodeJS.ProcessEnv): Pool;
  createStore(pool: Pool): OperatorEligibilityStore;
  createAdmission(env: NodeJS.ProcessEnv): OperatorEligibilityAdmission;
}
const productionBoundaries: ProductionOperatorEligibilityBoundaries = Object.freeze({
  getPool: getDowntownUOperatorPool,
  createStore: (pool: Pool) => new PostgresOperatorEligibilityStore(pool),
  createAdmission: createOperatorEligibilityAdmission,
});
export function createProductionOperatorEligibilityHandler(environment: () => NodeJS.ProcessEnv = () => process.env,
  boundaries: ProductionOperatorEligibilityBoundaries = productionBoundaries,
  dependencies: { randomUUID: () => string } = { randomUUID: nodeRandomUUID }) {
  return async (request: NodeOperatorEligibilityRequest, response: NodeOperatorEligibilityResponse): Promise<void> => {
    const requestMethod = method(request);
    if (requestMethod === null) { send(response, 400, errors.invalid); return; }
    if (requestMethod !== "POST") { response.setHeader("Allow", "POST"); send(response, 405, errors.method); return; }
    const suppliedOrigin = claimedOrigin(request);
    let parsed: ParsedOperatorEligibilityMutation;
    try { parsed = await parseOperatorEligibilityMutationRequest(request, suppliedOrigin ?? ""); }
    catch (error) { boundaryError(response, error); return; }
    let env: NodeJS.ProcessEnv; let origin: string;
    try { env = environment(); origin = parseOperatorPublicOrigin(env.DOWNTOWN_U_PUBLIC_APP_ORIGIN); }
    catch { send(response, 503, errors.unavailable); return; }
    if (suppliedOrigin !== origin) { send(response, 403, errors.forbidden); return; }
    await execute(parsed, origin, response, () => {
      if (env.DOWNTOWN_U_OPERATOR_ENABLED !== "1" || env.DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED !== "1") throw new Error("disabled");
      const cryptography = operatorAuthCryptographyFromEnvironment(env);
      operatorDatabasePoolConfig(env);
      const admission = boundaries.createAdmission(env);
      const store = boundaries.createStore(boundaries.getPool(env));
      return { cryptography, admission, store };
    }, dependencies.randomUUID);
  };
}
