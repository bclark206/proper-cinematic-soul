import type { Pool, PoolClient, QueryResultRow } from "pg";
import { IdempotencyConflictError } from "./credits";
import type { EligibilityStatus, StudentAccount, StudentAccountStore } from "./student-accounts";
import { withPostgresTransaction } from "./postgres-transaction";

interface StudentRow extends QueryResultRow {
  id: string;
  normalized_email: string | null;
  normalized_phone: string | null;
  square_customer_id: string | null;
  eligibility_status: EligibilityStatus;
}
function fromRow(row: StudentRow): StudentAccount {
  return {
    id: row.id,
    eligibilityStatus: row.eligibility_status,
    ...(row.normalized_email ? { normalizedEmail: row.normalized_email } : {}),
    ...(row.normalized_phone ? { normalizedPhone: row.normalized_phone } : {}),
    ...(row.square_customer_id ? { squareCustomerId: row.square_customer_id } : {}),
  };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export class PostgresStudentAccountStore implements StudentAccountStore {
  constructor(private readonly pool: Pool) {}

  private compatible(account: StudentAccount, input: Parameters<StudentAccountStore["upsert"]>[0]): boolean {
    return (!account.normalizedEmail || !input.normalizedEmail || account.normalizedEmail === input.normalizedEmail)
      && (!account.normalizedPhone || !input.normalizedPhone || account.normalizedPhone === input.normalizedPhone)
      && (!account.squareCustomerId || !input.squareCustomerId || account.squareCustomerId === input.squareCustomerId);
  }

  private async operation(client: PoolClient, input: Parameters<StudentAccountStore["upsert"]>[0]): Promise<StudentAccount> {
    const matches = await client.query<StudentRow>(`SELECT * FROM downtown_u_students
      WHERE normalized_email = $1 OR normalized_phone = $2 OR square_customer_id = $3 FOR UPDATE`,
    [input.normalizedEmail ?? null, input.normalizedPhone ?? null, input.squareCustomerId ?? null]);
    if ((matches.rowCount ?? 0) > 1) throw new IdempotencyConflictError();
    if (matches.rowCount) {
      const account = fromRow(matches.rows[0]);
      if (!this.compatible(account, input)) throw new IdempotencyConflictError();
      const updated = await client.query<StudentRow>(`UPDATE downtown_u_students SET
        normalized_email=COALESCE(normalized_email,$2), normalized_phone=COALESCE(normalized_phone,$3),
        square_customer_id=COALESCE(square_customer_id,$4), updated_at=now() WHERE id=$1 RETURNING *`,
      [account.id, input.normalizedEmail ?? null, input.normalizedPhone ?? null, input.squareCustomerId ?? null]);
      return fromRow(updated.rows[0]);
    }
    const inserted = await client.query<StudentRow>(`INSERT INTO downtown_u_students
      (normalized_email, normalized_phone, square_customer_id) VALUES ($1,$2,$3) RETURNING *`,
    [input.normalizedEmail ?? null, input.normalizedPhone ?? null, input.squareCustomerId ?? null]);
    return fromRow(inserted.rows[0]);
  }

  async upsert(input: Parameters<StudentAccountStore["upsert"]>[0]): Promise<StudentAccount> {
    const attempt = async (): Promise<StudentAccount> => {
      return withPostgresTransaction(this.pool, (client) => this.operation(client, input));
    };
    try { return await attempt(); }
    catch (error) {
      if (!isUniqueViolation(error)) throw error;
      try { return await attempt(); }
      catch (retryError) { if (isUniqueViolation(retryError)) throw new IdempotencyConflictError(); throw retryError; }
    }
  }
}
