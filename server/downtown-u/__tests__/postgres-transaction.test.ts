import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withPostgresTransaction } from "../postgres-transaction";

function fakePool(options: { operationError?: Error; rollbackError?: Error } = {}) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.rollbackError) throw options.rollbackError;
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const operation = vi.fn(async () => {
    if (options.operationError) throw options.operationError;
    return "result";
  });
  return { pool, client, query, release, operation };
}

describe("PostgreSQL transaction cleanup", () => {
  it("commits successful operations and releases the client normally", async () => {
    const fake = fakePool();

    await expect(withPostgresTransaction(fake.pool, fake.operation)).resolves.toBe("result");
    expect(fake.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(fake.release).toHaveBeenCalledWith();
  });

  it("rolls back operation failures, preserves the original error, and releases normally", async () => {
    const original = new Error("operation failed");
    const fake = fakePool({ operationError: original });

    let thrown: unknown;
    try { await withPostgresTransaction(fake.pool, fake.operation); } catch (error) { thrown = error; }
    expect(thrown).toBe(original);
    expect(fake.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(fake.release).toHaveBeenCalledWith();
  });

  it("preserves the operation error and destroys the client when rollback also fails", async () => {
    const original = new Error("operation failed");
    const rollback = new Error("rollback failed");
    const fake = fakePool({ operationError: original, rollbackError: rollback });

    let thrown: unknown;
    try { await withPostgresTransaction(fake.pool, fake.operation); } catch (error) { thrown = error; }
    expect(thrown).toBe(original);
    expect(fake.release).toHaveBeenCalledWith(rollback);
  });
});
