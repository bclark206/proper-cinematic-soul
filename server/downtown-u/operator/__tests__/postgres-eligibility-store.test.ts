import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  OperatorEligibilityStoreError,
  PostgresOperatorEligibilityStore,
  type OperatorEligibilityMutationInput,
} from "../postgres-eligibility-store";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const studentId = "223e4567-e89b-42d3-a456-426614174000";
const auditId = "323e4567-e89b-42d3-a456-426614174000";
const eventId = "423e4567-e89b-42d3-a456-426614174000";
const digest = Buffer.alloc(32, 7);
const expectedUpdatedAt = "2026-08-06T12:00:00.000Z";
const correlationId = "operator-mutation:523e4567-e89b-42d3-a456-426614174000";
const idempotencyKey = "opm:v1:623e4567-e89b-42d3-a456-426614174000";
const exactSql = "SELECT * FROM public.downtown_u_operator_set_eligibility($1::uuid,$2::smallint,$3::bytea,$4::text,$5::text,$6::uuid,$7::uuid,$8::uuid,$9::text,$10::timestamptz,$11::text,$12::text,$13::text)";

const input: OperatorEligibilityMutationInput = Object.freeze({
  sessionId,
  sessionVersion: 1,
  sessionDigest: digest,
  correlationId,
  idempotencyKey,
  auditId,
  eventId,
  studentId,
  expectedStatus: "pending",
  expectedUpdatedAt,
  decision: "approve",
  reasonCode: "documentation_verified",
  reason: "Documents verified",
});

const updatedRow = Object.freeze({
  outcome: "updated",
  replayed: false,
  item: {
    studentId,
    eligibilityStatus: "approved",
    eligibilityReviewedAt: expectedUpdatedAt,
    approvedAt: expectedUpdatedAt,
    updatedAt: expectedUpdatedAt,
  },
});

function harness(row: unknown = updatedRow, options: { rowCount?: number | null; throwOn?: string } = {}) {
  const events: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    events.push(sql);
    if (options.throwOn === sql || (options.throwOn === "CAPABILITY" && sql === exactSql)) throw new Error("opaque database failure");
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql === "PREFLIGHT") return { rowCount: 1, rows: [{ safe_operator_identity: true }] };
    return { rowCount: options.rowCount === undefined ? 1 : options.rowCount, rows: options.rowCount === 0 ? [] : [row] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const preflight = vi.fn(async (checked: PoolClient) => {
    expect(checked).toBe(client);
    await checked.query("PREFLIGHT");
  });
  return { store: new PostgresOperatorEligibilityStore(pool, preflight), pool, client, query, release, preflight, events };
}

describe("Postgres eligibility mutation store", () => {
  it("uses one checked-out transaction, runtime preflight, and one exact capability call", async () => {
    const h = harness();
    await expect(h.store.mutate(input)).resolves.toEqual({
      outcome: "updated",
      replayed: false,
      item: {
        studentId,
        eligibilityStatus: "approved",
        eligibilityReviewedAt: expectedUpdatedAt,
        approvedAt: expectedUpdatedAt,
        updatedAt: expectedUpdatedAt,
      },
    });
    expect(h.events).toEqual(["BEGIN", "PREFLIGHT", exactSql, "COMMIT"]);
    expect(h.query.mock.calls.filter(([sql]) => sql === exactSql)).toHaveLength(1);
    expect(h.query.mock.calls.find(([sql]) => sql === exactSql)?.[1]).toEqual([
      sessionId, 1, digest, correlationId, idempotencyKey, auditId, eventId,
      studentId, "pending", expectedUpdatedAt, "approve", "documentation_verified", "Documents verified",
    ]);
    expect(h.query.mock.calls.find(([sql]) => sql === exactSql)?.[1]?.[2]).not.toBe(digest);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("preserves the same exact call ordering and maps replayed success", async () => {
    const h = harness({ ...updatedRow, replayed: true });
    await expect(h.store.mutate(input)).resolves.toMatchObject({ outcome: "updated", replayed: true });
    expect(h.events).toEqual(["BEGIN", "PREFLIGHT", exactSql, "COMMIT"]);
  });

  it.each([
    "invalid", "denied", "reauth_required", "not_found", "stale_state", "conflict", "idempotency_conflict",
  ])("maps exact null-item outcome %s", async (outcome) => {
    const h = harness({ outcome, replayed: false, item: null });
    await expect(h.store.mutate(input)).resolves.toEqual({ outcome, replayed: false, item: null });
    expect(h.events.at(-1)).toBe("COMMIT");
  });

  it.each([
    { sessionId: sessionId.toUpperCase() },
    { sessionVersion: 0 }, { sessionVersion: 1.5 }, { sessionDigest: Buffer.alloc(31) },
    { correlationId: "client-correlation" }, { idempotencyKey: idempotencyKey.toUpperCase() },
    { auditId: auditId.toUpperCase() }, { eventId: "bad" }, { studentId: studentId.toUpperCase() },
    { expectedStatus: "approved" }, { expectedUpdatedAt: "2026-08-06T12:00:00Z" },
    { decision: "reject" }, { reasonCode: "policy_hold" }, { reason: " untrimmed" },
    { extra: true },
  ])("fails closed before pool checkout for malformed input %#", async (change) => {
    const h = harness();
    await expect(h.store.mutate({ ...input, ...change } as never)).resolves.toEqual({ outcome: "invalid", replayed: false, item: null });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects accessors, symbols, prototypes, buffers and proxy traps before pool without invoking getters", async () => {
    const getter = vi.fn(() => studentId);
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, "studentId", { enumerable: true, get: getter });
    const symbol = { ...input, [Symbol("secret")]: "x" };
    const prototype = Object.assign(Object.create({ inherited: true }), input);
    const buffer = Buffer.from("secret");
    const proxy = new Proxy({}, { ownKeys() { throw new TypeError("trap"); } });
    for (const candidate of [accessor, symbol, prototype, buffer, proxy]) {
      const h = harness();
      await expect(h.store.mutate(candidate as never)).resolves.toEqual({ outcome: "invalid", replayed: false, item: null });
      expect(h.pool.connect).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...updatedRow, extra: "secret" }],
    [{ ...updatedRow, item: { ...updatedRow.item, studentId: studentId.toUpperCase() } }],
    [{ ...updatedRow, outcome: "unknown" }],
    [{ ...updatedRow, replayed: "false" }],
    [{ ...updatedRow, item: { ...updatedRow.item, eligibilityStatus: "pending" } }],
    [{ ...updatedRow, item: { ...updatedRow.item, approvedAt: undefined } }],
    [{ ...updatedRow, item: { ...updatedRow.item, rejectedAt: expectedUpdatedAt } }],
    [{ ...updatedRow, item: Buffer.from("secret") }],
    [Object.assign(Object.create({ inherited: true }), updatedRow)],
  ])("rolls back malformed capability row %#", async (row) => {
    const h = harness(row);
    await expect(h.store.mutate(input)).rejects.toBeInstanceOf(OperatorEligibilityStoreError);
    expect(h.events.at(-1)).toBe("ROLLBACK");
    expect(h.events).not.toContain("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("rejects accessor/symbol/proxy rows without invoking getters and rolls back", async () => {
    const getter = vi.fn(() => "updated");
    const accessor = { ...updatedRow } as Record<string, unknown>;
    Object.defineProperty(accessor, "outcome", { enumerable: true, get: getter });
    const symbol = { ...updatedRow, [Symbol("secret")]: true };
    const traps = { getPrototypeOf: vi.fn(), ownKeys: vi.fn(), getOwnPropertyDescriptor: vi.fn() };
    const proxy = new Proxy({}, traps);
    for (const row of [accessor, symbol, proxy]) {
      const h = harness(row);
      await expect(h.store.mutate(input)).rejects.toBeInstanceOf(OperatorEligibilityStoreError);
      expect(h.events.at(-1)).toBe("ROLLBACK");
    }
    expect(getter).not.toHaveBeenCalled();
    for (const trap of Object.values(traps)) expect(trap).not.toHaveBeenCalled();
  });

  it("detaches all fields and copies the digest before pool checkout awaits", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const h = harness();
    const client = h.client;
    (h.pool.connect as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { await gate; return client; });
    const mutable = { ...input, sessionDigest: Buffer.from(digest) };
    const pending = h.store.mutate(mutable);
    mutable.studentId = "723e4567-e89b-42d3-a456-426614174000";
    mutable.reason = "Changed after invocation";
    mutable.sessionDigest.fill(9);
    open();
    await expect(pending).resolves.toMatchObject({ outcome: "updated" });
    const parameters = h.query.mock.calls.find(([sql]) => sql === exactSql)?.[1] as unknown[];
    expect(parameters[7]).toBe(studentId);
    expect(parameters[12]).toBe("Documents verified");
    expect(parameters[2]).toEqual(digest);
  });

  it.each([0, 2, null])("requires exactly one capability row (rowCount=%s)", async (rowCount) => {
    const h = harness(updatedRow, { rowCount });
    await expect(h.store.mutate(input)).rejects.toBeInstanceOf(OperatorEligibilityStoreError);
    expect(h.events.at(-1)).toBe("ROLLBACK");
  });

  it("rolls back and releases on preflight and capability failures without leaking inputs", async () => {
    for (const stage of ["PREFLIGHT", "CAPABILITY"]) {
      const h = harness(updatedRow, { throwOn: stage });
      try {
        await h.store.mutate(input);
        throw new Error("expected store failure");
      } catch (error) {
        expect(error).toBeInstanceOf(OperatorEligibilityStoreError);
        expect(String(error)).not.toContain(digest.toString("hex"));
        expect(String(error)).not.toContain(input.reason);
        expect(String(error)).not.toContain(input.idempotencyKey);
      }
      expect(h.events.at(-1)).toBe("ROLLBACK");
      expect(h.release).toHaveBeenCalledOnce();
    }
  });

  it("wraps checkout errors as unavailable-safe store errors", async () => {
    const pool = { connect: vi.fn(async () => { throw new Error(input.reason); }) } as unknown as Pool;
    await expect(new PostgresOperatorEligibilityStore(pool).mutate(input)).rejects.toBeInstanceOf(OperatorEligibilityStoreError);
  });
});
