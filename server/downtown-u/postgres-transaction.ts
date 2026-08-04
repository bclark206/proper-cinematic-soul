import type { Pool, PoolClient } from "pg";

function asReleaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PostgreSQL rollback failed", { cause: error });
}

/** Runs an operation in a transaction without allowing cleanup errors to mask it. */
export async function withPostgresTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (error) {
    let broken: Error | undefined;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = asReleaseError(rollbackError);
    }
    try {
      if (broken) client.release(broken);
      else client.release();
    } catch {
      // The operation error is authoritative; release is best-effort cleanup.
    }
    throw error;
  }
}
