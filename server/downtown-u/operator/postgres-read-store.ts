import type { Pool } from "pg";
import { withPostgresTransaction } from "../postgres-transaction";
import {
  assertDowntownUOperatorRuntimeIdentity,
  type OperatorQueryable,
} from "./postgres-runtime-identity";
import {
  isCanonicalUuid,
  isIsoTimestamp,
  type OperatorReadEndpoint,
  type ReadFilters,
  type ReadPosition,
  validateReadItems,
} from "./read-types";

export interface OperatorReadStoreInput {
  endpoint: OperatorReadEndpoint;
  sessionId: string;
  sessionDigest: Buffer;
  correlationId: string;
  requestedLimit: number;
  cursor: ReadPosition | null;
  filters: ReadFilters;
}
export type OperatorReadStoreResult =
  | { outcome: "invalid" | "denied"; items: null }
  | { outcome: "authorized"; items: ReadonlyArray<Record<string, unknown>> };
export interface OperatorReadStore { read(input: OperatorReadStoreInput): Promise<OperatorReadStoreResult> }
export class OperatorReadStoreError extends Error {
  readonly kind = "unavailable" as const;
  constructor(cause: unknown) {
    super("Downtown U operator dashboard storage unavailable", { cause });
    this.name = "OperatorReadStoreError";
  }
}

const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const endpointFilters = {
  students: { keys: ["eligibilityStatus", "studentId"], enums: { eligibilityStatus: ["pending", "approved", "rejected", "suspended"] } },
  purchases: { keys: ["status", "studentId", "purchaseId"], enums: { status: ["paid", "partially_refunded", "refunded"] } },
  redemptions: { keys: ["status", "studentId", "redemptionId"], enums: { status: ["reserved", "redeemed", "reversed", "cancelled"] } },
  reconciliation: { keys: ["state", "category", "studentId", "caseId"], enums: { state: ["needs_review", "resolved"], category: ["payment_follow_up", "kitchen_follow_up"] } },
} as const;

function exactDataRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Buffer.isBuffer(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return null;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  return value as Record<string, unknown>;
}
function data(record: Record<string, unknown>, key: string): unknown {
  return (Object.getOwnPropertyDescriptor(record, key) as PropertyDescriptor & { value: unknown }).value;
}
function validateFilters(endpoint: OperatorReadEndpoint, value: unknown): ReadFilters | null {
  const definition = endpointFilters[endpoint];
  const record = exactDataRecord(value, definition.keys);
  if (!record) return null;
  const output: Record<string, string | null> = {};
  for (const key of definition.keys) {
    const candidate = data(record, key);
    if (candidate !== null && typeof candidate !== "string") return null;
    if (["studentId", "purchaseId", "redemptionId", "caseId"].includes(key)
      && candidate !== null && !isCanonicalUuid(candidate)) return null;
    const allowed = (definition.enums as Record<string, readonly string[]>)[key];
    if (allowed && candidate !== null && !allowed.includes(candidate as string)) return null;
    output[key] = candidate as string | null;
  }
  if (endpoint === "students") return { eligibilityStatus: output.eligibilityStatus, studentId: output.studentId };
  if (endpoint === "purchases") return { status: output.status, studentId: output.studentId, purchaseId: output.purchaseId };
  if (endpoint === "redemptions") return { status: output.status, studentId: output.studentId, redemptionId: output.redemptionId };
  return { state: output.state, category: output.category, studentId: output.studentId, caseId: output.caseId };
}
function validateCursor(value: unknown): ReadPosition | null | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, ["createdAt", "id"]);
  if (!record) return undefined;
  const createdAt = data(record, "createdAt");
  const id = data(record, "id");
  return isIsoTimestamp(createdAt) && isCanonicalUuid(id) ? { createdAt, id } : undefined;
}
function validatedInput(value: unknown): OperatorReadStoreInput | null {
  try {
    const record = exactDataRecord(value, ["endpoint", "sessionId", "sessionDigest", "correlationId", "requestedLimit", "cursor", "filters"]);
    if (!record) return null;
    const endpoint = data(record, "endpoint");
    if (!(["students", "purchases", "redemptions", "reconciliation"] as unknown[]).includes(endpoint)) return null;
    const sessionId = data(record, "sessionId");
    const digest = data(record, "sessionDigest");
    const correlationId = data(record, "correlationId");
    const requestedLimit = data(record, "requestedLimit");
    if (!isCanonicalUuid(sessionId) || !Buffer.isBuffer(digest) || digest.length !== 32
      || typeof correlationId !== "string" || !CORRELATION.test(correlationId)
      || !Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 101) return null;
    const cursor = validateCursor(data(record, "cursor"));
    const filters = validateFilters(endpoint as OperatorReadEndpoint, data(record, "filters"));
    if (cursor === undefined || !filters) return null;
    return {
      endpoint: endpoint as OperatorReadEndpoint,
      sessionId,
      sessionDigest: Buffer.from(digest),
      correlationId,
      requestedLimit: requestedLimit as number,
      cursor,
      filters,
    };
  } catch { return null; }
}

function capabilityRow(result: { rowCount: number | null; rows: unknown[] }): Record<string, unknown> {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("Invalid read capability result");
  const record = exactDataRecord(result.rows[0], ["outcome", "items"]);
  if (!record) throw new Error("Invalid read capability result");
  return record;
}
function args(input: OperatorReadStoreInput): unknown[] {
  const base = [input.sessionId, 1, Buffer.from(input.sessionDigest), input.correlationId, input.requestedLimit,
    input.cursor?.createdAt ?? null, input.cursor?.id ?? null];
  if (input.endpoint === "students") {
    const filter = input.filters as { eligibilityStatus: string | null; studentId: string | null };
    return [...base, filter.eligibilityStatus, filter.studentId];
  }
  if (input.endpoint === "purchases") {
    const filter = input.filters as { status: string | null; studentId: string | null; purchaseId: string | null };
    return [...base, filter.status, filter.studentId, filter.purchaseId];
  }
  if (input.endpoint === "redemptions") {
    const filter = input.filters as { status: string | null; studentId: string | null; redemptionId: string | null };
    return [...base, filter.status, filter.studentId, filter.redemptionId];
  }
  const filter = input.filters as { state: string | null; category: string | null; studentId: string | null; caseId: string | null };
  return [...base, filter.state, filter.category, filter.studentId, filter.caseId];
}
const sql = {
  students: "SELECT * FROM public.downtown_u_operator_read_students($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid)",
  purchases: "SELECT * FROM public.downtown_u_operator_read_purchases($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
  redemptions: "SELECT * FROM public.downtown_u_operator_read_redemptions($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
  reconciliation: "SELECT * FROM public.downtown_u_operator_read_reconciliation($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::text,$10::uuid,$11::uuid)",
} as const;

export class PostgresOperatorReadStore implements OperatorReadStore {
  constructor(
    private readonly pool: Pool,
    private readonly preflight: (queryable: OperatorQueryable) => Promise<void> = assertDowntownUOperatorRuntimeIdentity,
  ) {}
  async read(rawInput: OperatorReadStoreInput): Promise<OperatorReadStoreResult> {
    const input = validatedInput(rawInput);
    if (!input) return { outcome: "invalid", items: null };
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        await this.preflight(client);
        const row = capabilityRow(await client.query(sql[input.endpoint], args(input)));
        const outcome = data(row, "outcome");
        const items = data(row, "items");
        if ((outcome === "invalid" || outcome === "denied") && items === null) return { outcome, items: null };
        if (outcome !== "authorized") throw new Error("Invalid read capability outcome");
        return { outcome: "authorized", items: validateReadItems(input.endpoint, items) };
      });
    } catch (cause) {
      if (cause instanceof OperatorReadStoreError) throw cause;
      throw new OperatorReadStoreError(cause);
    }
  }
}
