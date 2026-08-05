import type { Pool, QueryResultRow } from "pg";
import { IdempotencyConflictError } from "./credits";
import { assertDowntownURuntimeIdentity } from "./postgres-runtime-identity";
import type { EligibilityStatus, StudentAccount, StudentAccountStore } from "./student-accounts";

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
function isIdentityConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (("code" in error && (error.code === "23505" || error.code === "P0001"))
      || ("message" in error && String(error.message).includes("Downtown U student identity conflict")));
}

export class PostgresStudentAccountStore implements StudentAccountStore {
  constructor(
    private readonly pool: Pool,
    private readonly identityPreflight: (pool: Pool) => Promise<void> = assertDowntownURuntimeIdentity,
  ) {}

  async upsert(input: Parameters<StudentAccountStore["upsert"]>[0]): Promise<StudentAccount> {
    await this.identityPreflight(this.pool);
    try {
      const result = await this.pool.query<StudentRow>(
        "SELECT * FROM public.downtown_u_upsert_pending_student($1,$2,$3)",
        [input.normalizedEmail ?? null, input.normalizedPhone ?? null, input.squareCustomerId ?? null],
      );
      if (result.rows.length !== 1) throw new IdempotencyConflictError();
      return fromRow(result.rows[0]);
    } catch (error) {
      if (isIdentityConflict(error)) throw new IdempotencyConflictError();
      throw error;
    }
  }
}
