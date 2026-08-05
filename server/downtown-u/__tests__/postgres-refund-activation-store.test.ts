import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { TrustedRefundCommand } from "../enrollment-service";
import { RefundActivationConflictError, type ClaimedSquareWebhook } from "../payment-activation";
import { PostgresRefundActivationStore } from "../postgres-refund-activation-store";

const claim: ClaimedSquareWebhook = {
  eventId: "EVT_REFUND_BOUNDARY",
  eventType: "refund.updated",
  bodyHash: "a".repeat(64),
  resourceId: "REFUND_BOUNDARY",
  claimToken: "11111111-1111-4111-8111-111111111111",
  attemptCount: 1,
};
const command: TrustedRefundCommand = {
  refundId: "REFUND_BOUNDARY",
  paymentId: "PAY_BOUNDARY",
  orderId: "ORDER_BOUNDARY",
  amount: 40_000,
  currency: "USD",
  locationId: "LOC_1",
  updatedAt: "2026-08-05T12:00:00.123456789Z",
};

function fakeStore(queryFailure?: unknown) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT * FROM public.downtown_u_activate_verified_refund")) {
      if (queryFailure) throw queryFailure;
      return { rows: [{ outcome: "applied" }], rowCount: 1 };
    }
    return { rows: [], rowCount: null, values };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const identityPreflight = vi.fn(async () => undefined);
  return { store: new PostgresRefundActivationStore(pool, identityPreflight), pool, query, identityPreflight };
}

describe("PostgreSQL refund activation store boundaries", () => {
  it.each([40_001, Number.MAX_SAFE_INTEGER])(
    "rejects amount %s permanently before identity preflight or a database connection",
    async (amount) => {
      const fake = fakeStore();
      await expect(fake.store.activate(claim, { ...command, amount }))
        .rejects.toBeInstanceOf(RefundActivationConflictError);
      expect(fake.identityPreflight).not.toHaveBeenCalled();
      expect(fake.pool.connect).not.toHaveBeenCalled();
    },
  );

  it("accepts the maximum canonical plan price through the database call boundary", async () => {
    const fake = fakeStore();
    await expect(fake.store.activate(claim, command)).resolves.toEqual({ outcome: "applied" });
    expect(fake.identityPreflight).toHaveBeenCalledOnce();
    const activation = fake.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("SELECT * FROM public.downtown_u_activate_verified_refund"));
    expect(activation?.[1]?.[6]).toBe(40_000);
  });

  it("classifies PostgreSQL integer out-of-range as a permanent activation conflict", async () => {
    const fake = fakeStore({ code: "22003" });
    await expect(fake.store.activate(claim, command))
      .rejects.toBeInstanceOf(RefundActivationConflictError);
    expect(fake.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  });
});
