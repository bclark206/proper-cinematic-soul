import type { Pool, PoolClient } from "pg";
import { assertDowntownUOperatorRuntimeIdentity } from "./postgres-runtime-identity";
import { isCanonicalUuid, validateEligibilityMutationBody, validateEligibilityMutationItem, type OperatorEligibilityMutationBody, type OperatorEligibilityMutationItem } from "./eligibility-types";
import { exactOwnData } from "./trusted-result";

export interface OperatorEligibilityMutationInput extends OperatorEligibilityMutationBody {
  readonly sessionId: string;
  readonly sessionVersion: 1;
  readonly sessionDigest: Buffer;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly auditId: string;
  readonly eventId: string;
}
export type OperatorEligibilityMutationOutcome = "invalid" | "denied" | "reauth_required" | "not_found" | "stale_state" | "conflict" | "idempotency_conflict";
export type OperatorEligibilityMutationResult =
  | { readonly outcome: "updated"; readonly replayed: boolean; readonly item: OperatorEligibilityMutationItem }
  | { readonly outcome: OperatorEligibilityMutationOutcome; readonly replayed: false; readonly item: null };
export interface OperatorEligibilityStore { mutate(input: OperatorEligibilityMutationInput): Promise<OperatorEligibilityMutationResult> }
export class OperatorEligibilityStoreError extends Error {
  readonly kind = "unavailable" as const;
  constructor(cause?: unknown) {
    super("Downtown U operator eligibility storage unavailable", { cause });
    this.name = "OperatorEligibilityStoreError";
  }
}

const SQL = "SELECT * FROM public.downtown_u_operator_set_eligibility($1::uuid,$2::smallint,$3::bytea,$4::text,$5::text,$6::uuid,$7::uuid,$8::uuid,$9::text,$10::timestamptz,$11::text,$12::text,$13::text)";
const CORRELATION = /^operator-mutation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY = /^opm:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEYS = ["sessionId", "sessionVersion", "sessionDigest", "correlationId", "idempotencyKey", "auditId", "eventId", "studentId", "expectedStatus", "expectedUpdatedAt", "decision", "reasonCode", "reason"] as const;
const ROW_KEYS = ["outcome", "replayed", "item"] as const;
const FAILURES = new Set<OperatorEligibilityMutationOutcome>(["invalid", "denied", "reauth_required", "not_found", "stale_state", "conflict", "idempotency_conflict"]);

function validatedInput(value: unknown): OperatorEligibilityMutationInput | undefined {
  const input = exactOwnData(value, INPUT_KEYS); if (!input) return undefined;
  if (!isCanonicalUuid(input.sessionId) || input.sessionVersion !== 1 || !Buffer.isBuffer(input.sessionDigest) || input.sessionDigest.length !== 32
    || typeof input.correlationId !== "string" || !CORRELATION.test(input.correlationId)
    || typeof input.idempotencyKey !== "string" || !IDEMPOTENCY.test(input.idempotencyKey)
    || !isCanonicalUuid(input.auditId) || !isCanonicalUuid(input.eventId) || input.auditId === input.eventId) return undefined;
  let body: OperatorEligibilityMutationBody;
  try {
    body = validateEligibilityMutationBody({ studentId: input.studentId, expectedStatus: input.expectedStatus,
      expectedUpdatedAt: input.expectedUpdatedAt, decision: input.decision, reasonCode: input.reasonCode, reason: input.reason });
  } catch { return undefined; }
  return Object.freeze({
    sessionId: input.sessionId, sessionVersion: 1, sessionDigest: Buffer.from(input.sessionDigest),
    correlationId: input.correlationId, idempotencyKey: input.idempotencyKey, auditId: input.auditId,
    eventId: input.eventId, ...body,
  });
}
function capabilityResult(value: unknown): OperatorEligibilityMutationResult {
  const row = exactOwnData(value, ROW_KEYS);
  if (!row || typeof row.outcome !== "string" || typeof row.replayed !== "boolean") throw new OperatorEligibilityStoreError();
  if (FAILURES.has(row.outcome as OperatorEligibilityMutationOutcome)) {
    if (row.replayed !== false || row.item !== null) throw new OperatorEligibilityStoreError();
    return Object.freeze({ outcome: row.outcome as OperatorEligibilityMutationOutcome, replayed: false, item: null });
  }
  if (row.outcome !== "updated") throw new OperatorEligibilityStoreError();
  let trusted: OperatorEligibilityMutationItem;
  try { trusted = validateEligibilityMutationItem(row.item); } catch { throw new OperatorEligibilityStoreError(); }
  return Object.freeze({ outcome: "updated", replayed: row.replayed, item: trusted });
}

export class PostgresOperatorEligibilityStore implements OperatorEligibilityStore {
  constructor(private readonly pool: Pool,
    private readonly preflight: (queryable: PoolClient) => Promise<void> = assertDowntownUOperatorRuntimeIdentity) {}

  async mutate(candidate: OperatorEligibilityMutationInput): Promise<OperatorEligibilityMutationResult> {
    const input = validatedInput(candidate);
    if (!input) return Object.freeze({ outcome: "invalid", replayed: false, item: null });
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch (cause) { throw new OperatorEligibilityStoreError(cause); }
    let begun = false;
    try {
      await client.query("BEGIN"); begun = true;
      await this.preflight(client);
      const result = await client.query(SQL, [
        input.sessionId, input.sessionVersion, Buffer.from(input.sessionDigest), input.correlationId, input.idempotencyKey,
        input.auditId, input.eventId, input.studentId, input.expectedStatus, input.expectedUpdatedAt,
        input.decision, input.reasonCode, input.reason,
      ]);
      if (result.rowCount !== 1 || result.rows.length !== 1) throw new OperatorEligibilityStoreError();
      const output = capabilityResult(result.rows[0]);
      await client.query("COMMIT");
      return output;
    } catch (cause) {
      if (begun) { try { await client.query("ROLLBACK"); } catch { /* preserve the opaque original failure */ } }
      throw cause instanceof OperatorEligibilityStoreError ? cause : new OperatorEligibilityStoreError(cause);
    } finally { client.release(); }
  }
}
