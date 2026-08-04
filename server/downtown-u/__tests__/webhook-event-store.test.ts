import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";
import { WebhookEventConflictError, WebhookEventTransitionError } from "../webhook-event-store";

function mockedPool(rows: unknown[]) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    return { rows } as QueryResult;
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, query, release };
}

describe("PostgresWebhookEventStore", () => {
  const store = (pool: Pool) => new PostgresWebhookEventStore(pool, async () => undefined);
  it.each([
    ["claimed", { outcome: "claimed", claim_token: "token", attempt_count: 1 }, { outcome: "claimed", claimToken: "token", attemptCount: 1 }],
    ["in progress", { outcome: "in_progress", claim_token: null, attempt_count: 1 }, { outcome: "in_progress", attemptCount: 1 }],
    ["duplicate", { outcome: "duplicate", claim_token: null, attempt_count: 2 }, { outcome: "duplicate", attemptCount: 2 }],
    ["exhausted", { outcome: "exhausted", claim_token: null, attempt_count: 1000 }, { outcome: "exhausted", attemptCount: 1000 }],
  ])("maps %s claim rows", async (_name, row, expected) => {
    const { pool, query, release } = mockedPool([row]);
    await expect(store(pool).claim("evt_1", "payment.updated", "a".repeat(64))).resolves.toEqual(expected);
    expect(query).toHaveBeenCalledWith("SELECT * FROM public.downtown_u_claim_webhook_event($1, $2, $3)", ["evt_1", "payment.updated", "a".repeat(64)]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("maps identity mismatch to a typed conflict without exposing DB detail", async () => {
    const { pool } = mockedPool([{ outcome: "conflict", claim_token: null, attempt_count: 1 }]);
    await expect(store(pool).claim("evt_1", "payment.updated", "a".repeat(64))).rejects.toBeInstanceOf(WebhookEventConflictError);
  });

  it("runs the runtime identity preflight before every transition", async () => {
    const allowed = mockedPool([{ transitioned: true }]);
    const preflight = vi.fn(async () => undefined);
    const eventStore = new PostgresWebhookEventStore(allowed.pool, preflight);

    await eventStore.complete("evt_1", "token-1");
    await eventStore.fail("evt_2", "token-2", "safe_code", "Safe detail");

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(preflight).toHaveBeenNthCalledWith(1, allowed.pool);
    expect(preflight).toHaveBeenNthCalledWith(2, allowed.pool);
  });

  it("requires claim ownership for complete/fail and validates safe failure fields", async () => {
    const denied = mockedPool([{ transitioned: false }]);
    await expect(store(denied.pool).complete("evt_1", "wrong-token")).rejects.toBeInstanceOf(WebhookEventTransitionError);
    const eventStore = store(denied.pool);
    await expect(eventStore.fail("evt_1", "token", "bad code", "safe")).rejects.toThrow(/failure code/i);
    await expect(eventStore.fail("evt_1", "token", "safe_code", "unsafe\ndetail")).rejects.toThrow(/failure detail/i);
    expect(denied.pool.connect).toHaveBeenCalledTimes(1);
  });
});
