import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  canonicalJson,
  IdempotencyConflictError,
  InsufficientCreditsError,
  InvalidCreditOperationError,
  type CreditStore,
  type LedgerMetadata,
  type PurchaseRecord,
  type RedemptionRecord,
} from "./credits";
import type { DowntownUPlanId } from "./plans";
import { withPostgresTransaction } from "./postgres-transaction";

interface PurchaseRow extends QueryResultRow {
  id: string; student_id: string; plan_id: DowntownUPlanId; square_payment_id: string;
  square_order_id: string; source_event_id: string; credits_granted: number;
  price_cents: number; status: PurchaseRecord["status"]; refunded_credits: number;
}
interface RedemptionRow extends QueryResultRow {
  id: string; student_id: string; credits: number; idempotency_key: string;
  status: RedemptionRecord["status"]; square_order_id: string | null;
}
interface BalanceRow extends QueryResultRow { credit_balance: number }
interface LedgerRow extends QueryResultRow {
  student_id: string; purchase_id: string | null; redemption_id: string | null;
  delta: number; transaction_type: string; reason: string; actor_type: string; actor_id: string;
  source_type: string; source_id: string; metadata: LedgerMetadata;
}

function purchaseFromRow(row: PurchaseRow): PurchaseRecord {
  return { id: row.id, studentId: row.student_id, planId: row.plan_id, squarePaymentId: row.square_payment_id,
    squareOrderId: row.square_order_id, sourceEventId: row.source_event_id, creditsGranted: row.credits_granted,
    priceCents: row.price_cents, status: row.status, refundedCredits: row.refunded_credits };
}
function redemptionFromRow(row: RedemptionRow): RedemptionRecord {
  return { id: row.id, studentId: row.student_id, credits: row.credits, idempotencyKey: row.idempotency_key,
    status: row.status, ...(row.square_order_id ? { squareOrderId: row.square_order_id } : {}) };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** PostgreSQL transport. Every balance-changing method uses one transaction and
 * locks the student row; the migration trigger independently checks the ledger chain. */
export class PostgresCreditStore implements CreditStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return withPostgresTransaction(this.pool, operation);
  }

  private async lockedBalance(client: PoolClient, studentId: string): Promise<number> {
    const result = await client.query<BalanceRow>("SELECT credit_balance FROM downtown_u_students WHERE id = $1 FOR UPDATE", [studentId]);
    if (!result.rowCount) throw new InvalidCreditOperationError("Student not found");
    return result.rows[0].credit_balance;
  }

  private validatePurchase(existing: PurchaseRecord, input: Parameters<CreditStore["grantPaidPurchase"]>[0]): PurchaseRecord {
    if (existing.studentId !== input.studentId || existing.planId !== input.planId || existing.squarePaymentId !== input.squarePaymentId || existing.squareOrderId !== input.squareOrderId || existing.sourceEventId !== input.sourceEventId || existing.creditsGranted !== input.credits || existing.priceCents !== input.priceCents) throw new IdempotencyConflictError();
    return existing;
  }

  private async findPurchaseBySources(client: PoolClient | Pool, input: Parameters<CreditStore["grantPaidPurchase"]>[0]): Promise<PurchaseRecord | null> {
    const result = await client.query<PurchaseRow>(`SELECT * FROM downtown_u_plan_purchases
      WHERE square_payment_id = $1 OR square_order_id = $2 OR source_event_id = $3`,
    [input.squarePaymentId, input.squareOrderId, input.sourceEventId]);
    if (!result.rowCount) return null;
    if (result.rowCount !== 1) throw new IdempotencyConflictError();
    const purchase = this.validatePurchase(purchaseFromRow(result.rows[0]), input);
    const audit = await client.query<LedgerRow>(`SELECT student_id, purchase_id, delta, transaction_type, reason,
      actor_type, actor_id, source_type, source_id, metadata FROM downtown_u_credit_transactions
      WHERE purchase_id=$1 AND transaction_type='purchase_grant'`, [purchase.id]);
    const row = audit.rows[0];
    if (audit.rowCount !== 1 || row.student_id !== input.studentId || row.delta !== input.credits
      || row.reason !== "verified_square_payment" || row.actor_type !== "square_webhook" || row.actor_id !== input.actorId
      || row.source_type !== "square_payment" || row.source_id !== input.squarePaymentId
      || canonicalJson(row.metadata) !== canonicalJson(input.metadata ?? {})) throw new IdempotencyConflictError();
    return purchase;
  }

  private async validateReservation(client: PoolClient | Pool, row: RedemptionRow, input: Parameters<CreditStore["reserve"]>[0]): Promise<RedemptionRecord> {
    const existing = redemptionFromRow(row);
    const audit = await client.query<LedgerRow>(`SELECT student_id, redemption_id, delta, transaction_type, reason,
      actor_type, actor_id, source_type, source_id, metadata FROM downtown_u_credit_transactions
      WHERE redemption_id=$1 AND transaction_type='reservation'`, [existing.id]);
    const ledger = audit.rows[0];
    if (existing.studentId !== input.studentId || existing.credits !== input.credits || audit.rowCount !== 1
      || ledger.delta !== -input.credits || ledger.reason !== "meal_reserved" || ledger.actor_type !== "student"
      || ledger.actor_id !== input.actorId || ledger.source_type !== "reservation_request"
      || ledger.source_id !== input.idempotencyKey || canonicalJson(ledger.metadata) !== canonicalJson(input.metadata ?? {})) throw new IdempotencyConflictError();
    return existing;
  }

  async grantPaidPurchase(input: Parameters<CreditStore["grantPaidPurchase"]>[0]): Promise<PurchaseRecord> {
    try {
      return await this.transaction(async (client) => {
        const existing = await this.findPurchaseBySources(client, input);
        if (existing) return existing;
        const balance = await this.lockedBalance(client, input.studentId);
        const inserted = await client.query<PurchaseRow>(`INSERT INTO downtown_u_plan_purchases
          (student_id, plan_id, credits_granted, price_cents, square_payment_id, square_order_id, source_event_id, paid_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *`,
        [input.studentId, input.planId, input.credits, input.priceCents, input.squarePaymentId, input.squareOrderId, input.sourceEventId]);
        const purchase = purchaseFromRow(inserted.rows[0]);
        await client.query(`INSERT INTO downtown_u_credit_transactions
          (student_id, purchase_id, delta, resulting_balance, transaction_type, reason, idempotency_key, actor_type, actor_id, source_type, source_id, metadata)
          VALUES ($1,$2,$3,$4,'purchase_grant','verified_square_payment',$5,'square_webhook',$6,'square_payment',$7,$8::jsonb)`,
        [input.studentId, purchase.id, input.credits, balance + input.credits, `purchase:${purchase.id}`, input.actorId, input.squarePaymentId, canonicalJson(input.metadata ?? {})]);
        return purchase;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPurchaseBySources(this.pool, input);
      if (!existing) throw error;
      return existing;
    }
  }

  async reserve(input: Parameters<CreditStore["reserve"]>[0]): Promise<RedemptionRecord> {
    try {
      return await this.transaction(async (client) => {
        const found = await client.query<RedemptionRow>("SELECT * FROM downtown_u_redemptions WHERE idempotency_key = $1", [input.idempotencyKey]);
        if (found.rowCount) return this.validateReservation(client, found.rows[0], input);
        const balance = await this.lockedBalance(client, input.studentId);
        if (balance < input.credits) throw new InsufficientCreditsError();
        const inserted = await client.query<RedemptionRow>(`INSERT INTO downtown_u_redemptions (student_id, credits, idempotency_key)
          VALUES ($1,$2,$3) RETURNING *`, [input.studentId, input.credits, input.idempotencyKey]);
        const redemption = redemptionFromRow(inserted.rows[0]);
        await client.query(`INSERT INTO downtown_u_credit_transactions
          (student_id, redemption_id, delta, resulting_balance, transaction_type, reason, idempotency_key, actor_type, actor_id, source_type, source_id, metadata)
          VALUES ($1,$2,$3,$4,'reservation','meal_reserved',$5,'student',$6,'reservation_request',$7,$8::jsonb)`,
        [input.studentId, redemption.id, -input.credits, balance - input.credits, `reservation:${input.idempotencyKey}`, input.actorId, input.idempotencyKey, canonicalJson(input.metadata ?? {})]);
        return redemption;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const found = await this.pool.query<RedemptionRow>("SELECT * FROM downtown_u_redemptions WHERE idempotency_key = $1", [input.idempotencyKey]);
      if (!found.rowCount) throw error;
      return this.validateReservation(this.pool, found.rows[0], input);
    }
  }

  redeem(input: Parameters<CreditStore["redeem"]>[0]): Promise<RedemptionRecord> {
    return this.transaction(async (client) => {
      const found = await client.query<RedemptionRow>("SELECT * FROM downtown_u_redemptions WHERE id = $1 FOR UPDATE", [input.redemptionId]);
      if (!found.rowCount) throw new InvalidCreditOperationError("Redemption not found");
      const current = redemptionFromRow(found.rows[0]);
      if (current.status === "redeemed" && current.squareOrderId === input.squareOrderId) return current;
      if (current.status !== "reserved") throw new InvalidCreditOperationError("Redemption cannot be redeemed");
      try {
        const updated = await client.query<RedemptionRow>(`UPDATE downtown_u_redemptions SET status='redeemed', square_order_id=$2,
          redeemed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [input.redemptionId, input.squareOrderId]);
        return redemptionFromRow(updated.rows[0]);
      } catch (error) { if (isUniqueViolation(error)) throw new IdempotencyConflictError(); throw error; }
    });
  }

  reverseRedemption(input: Parameters<CreditStore["reverseRedemption"]>[0]): Promise<RedemptionRecord> {
    return this.transaction(async (client) => {
      const found = await client.query<RedemptionRow>("SELECT * FROM downtown_u_redemptions WHERE id=$1 FOR UPDATE", [input.redemptionId]);
      if (!found.rowCount) throw new InvalidCreditOperationError("Redemption not found");
      const redemption = redemptionFromRow(found.rows[0]);
      const duplicate = await client.query<LedgerRow>("SELECT student_id, redemption_id, delta, transaction_type, reason, actor_type, actor_id, source_type, source_id, metadata FROM downtown_u_credit_transactions WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (duplicate.rowCount) {
        const row = duplicate.rows[0];
        if (row.student_id !== redemption.studentId || row.redemption_id !== redemption.id || row.delta !== redemption.credits
          || row.transaction_type !== "redemption_reversal" || row.reason !== input.reason || row.actor_type !== "order_service"
          || row.actor_id !== input.actorId || row.source_type !== "redemption_reversal" || row.source_id !== input.idempotencyKey
          || canonicalJson(row.metadata) !== canonicalJson(input.metadata ?? {})) throw new IdempotencyConflictError();
        return redemption;
      }
      if (redemption.status !== "reserved" && redemption.status !== "redeemed") throw new InvalidCreditOperationError("Redemption cannot be reversed");
      const balance = await this.lockedBalance(client, redemption.studentId);
      await client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id, redemption_id, delta, resulting_balance, transaction_type, reason, idempotency_key, actor_type, actor_id, source_type, source_id, metadata)
        VALUES ($1,$2,$3,$4,'redemption_reversal',$5,$6,'order_service',$7,'redemption_reversal',$6,$8::jsonb)`,
      [redemption.studentId, redemption.id, redemption.credits, balance + redemption.credits, input.reason, input.idempotencyKey, input.actorId, canonicalJson(input.metadata ?? {})]);
      const updated = await client.query<RedemptionRow>("UPDATE downtown_u_redemptions SET status='reversed', reversed_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [redemption.id]);
      return redemptionFromRow(updated.rows[0]);
    });
  }

  refundPurchase(input: Parameters<CreditStore["refundPurchase"]>[0]): Promise<PurchaseRecord> {
    return this.transaction(async (client) => {
      const found = await client.query<PurchaseRow>("SELECT * FROM downtown_u_plan_purchases WHERE id=$1 FOR UPDATE", [input.purchaseId]);
      if (!found.rowCount) throw new InvalidCreditOperationError("Purchase not found");
      const purchase = purchaseFromRow(found.rows[0]);
      const duplicate = await client.query<LedgerRow>("SELECT student_id, purchase_id, delta, transaction_type, reason, actor_type, actor_id, source_type, source_id, metadata FROM downtown_u_credit_transactions WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (duplicate.rowCount) {
        const row = duplicate.rows[0];
        if (row.student_id !== purchase.studentId || row.purchase_id !== purchase.id || row.delta !== -input.creditsToReverse
          || row.transaction_type !== "purchase_refund" || row.reason !== "square_refund" || row.actor_type !== "square_webhook"
          || row.actor_id !== input.actorId || row.source_type !== "square_refund" || row.source_id !== input.idempotencyKey
          || canonicalJson(row.metadata) !== canonicalJson(input.metadata ?? {})) throw new IdempotencyConflictError();
        return purchase;
      }
      const refundedCredits = purchase.refundedCredits + input.creditsToReverse;
      if (refundedCredits > purchase.creditsGranted) throw new InvalidCreditOperationError("Refund exceeds purchased credits");
      const balance = await this.lockedBalance(client, purchase.studentId);
      if (balance < input.creditsToReverse) throw new InsufficientCreditsError();
      await client.query(`INSERT INTO downtown_u_credit_transactions
        (student_id, purchase_id, delta, resulting_balance, transaction_type, reason, idempotency_key, actor_type, actor_id, source_type, source_id, metadata)
        VALUES ($1,$2,$3,$4,'purchase_refund','square_refund',$5,'square_webhook',$6,'square_refund',$5,$7::jsonb)`,
      [purchase.studentId, purchase.id, -input.creditsToReverse, balance - input.creditsToReverse, input.idempotencyKey, input.actorId, canonicalJson(input.metadata ?? {})]);
      const status = refundedCredits === purchase.creditsGranted ? "refunded" : "partially_refunded";
      const updated = await client.query<PurchaseRow>(`UPDATE downtown_u_plan_purchases SET refunded_credits=$2, status=$3,
        refunded_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
      [purchase.id, refundedCredits, status]);
      return purchaseFromRow(updated.rows[0]);
    });
  }
}
