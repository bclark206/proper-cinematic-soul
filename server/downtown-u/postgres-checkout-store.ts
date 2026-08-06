import type { Pool, QueryResultRow } from "pg";
import type { CheckoutAttempt, CheckoutState, CheckoutStore } from "./checkout";
import type { DowntownUPlanId } from "./plans";
import { assertDowntownURuntimeIdentity, type Queryable } from "./postgres-runtime-identity";
import { withPostgresTransaction } from "./postgres-transaction";

interface Row extends QueryResultRow { id: string; idempotency_key: string; plan_id: DowntownUPlanId; normalized_email: string; state: CheckoutState; square_order_id: string | null; square_payment_id: string | null }
export class CheckoutRateLimitError extends Error { constructor() { super("checkout rate limited"); this.name = "CheckoutRateLimitError"; } }
export class CheckoutConflictError extends Error { constructor() { super("checkout conflict"); this.name = "CheckoutConflictError"; } }
function attempt(row: Row): CheckoutAttempt {
  if (!row || typeof row.id !== "string" || typeof row.idempotency_key !== "string" || typeof row.normalized_email !== "string") throw new Error("invalid checkout capability result");
  return { id: row.id, idempotencyKey: row.idempotency_key, planId: row.plan_id, normalizedEmail: row.normalized_email, state: row.state, ...(row.square_order_id ? { squareOrderId: row.square_order_id } : {}), ...(row.square_payment_id ? { squarePaymentId: row.square_payment_id } : {}) };
}
function map(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "DU429") throw new CheckoutRateLimitError();
  if (code === "DU409" || ["23503", "23505", "23514"].includes(code)) throw new CheckoutConflictError();
  throw error;
}
export class PostgresCheckoutStore implements CheckoutStore {
  constructor(private readonly pool: Pool, private readonly preflight: (q: Queryable) => Promise<void> = assertDowntownURuntimeIdentity) {}
  private async query(sql: string, parameters: unknown[]): Promise<Row[]> {
    try { return await withPostgresTransaction(this.pool, async client => { await this.preflight(client); return (await client.query<Row>(sql, parameters)).rows; }); }
    catch (error) { map(error); }
  }
  private async one(sql: string, parameters: unknown[]): Promise<CheckoutAttempt> { const rows = await this.query(sql, parameters); if (rows.length !== 1) throw new Error("invalid checkout capability result"); return attempt(rows[0]); }
  begin(input: { idempotencyKey: string; planId: DowntownUPlanId; normalizedEmail: string; requestActor: Buffer }): Promise<CheckoutAttempt> {
    return this.one("SELECT * FROM public.downtown_u_checkout_begin($1,$2,$3,$4)", [input.idempotencyKey, input.planId, input.normalizedEmail, input.requestActor]);
  }
  recordOrder(id: string, orderId: string): Promise<CheckoutAttempt> { return this.one("SELECT * FROM public.downtown_u_checkout_record($1,$2,$3)", [id, "order", orderId]); }
  recordPayment(id: string, paymentId: string): Promise<CheckoutAttempt> { return this.one("SELECT * FROM public.downtown_u_checkout_record($1,$2,$3)", [id, "payment", paymentId]); }
  transition(id: string, state: "paid" | "operator_review" | "failed"): Promise<CheckoutAttempt> { return this.one("SELECT * FROM public.downtown_u_checkout_transition($1,$2)", [id, state]); }
  async readPublic(id: string): Promise<{ state: CheckoutState } | null> { const rows = await this.query("SELECT * FROM public.downtown_u_checkout_status($1)", [id]); if (rows.length > 1) throw new Error("invalid checkout capability result"); return rows[0] ? { state: rows[0].state } : null; }
}
