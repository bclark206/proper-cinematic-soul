import type { Pool } from "pg";
import type { TrustedRefundCommand } from "./enrollment-service";
import {
  RefundActivationConflictError,
  type ClaimedSquareWebhook,
  type RefundActivationStore,
} from "./payment-activation";
import { assertDowntownURuntimeIdentity } from "./postgres-runtime-identity";
import { withPostgresTransaction } from "./postgres-transaction";
import { MAX_DOWNTOWN_U_PLAN_PRICE_CENTS } from "./plans";
import { SQUARE_RESOURCE_ID_PATTERN } from "./square-client";

interface ActivationRow { outcome: string }

function knownConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["P0001", "22003", "22023", "23503", "23505", "23514"].includes(String(error.code));
}

function validateInput(claim: ClaimedSquareWebhook, command: TrustedRefundCommand): void {
  if (claim.eventType !== "refund.updated" || claim.resourceId !== command.refundId
    || !SQUARE_RESOURCE_ID_PATTERN.test(command.refundId)
    || !SQUARE_RESOURCE_ID_PATTERN.test(command.paymentId)
    || (command.orderId !== undefined && !SQUARE_RESOURCE_ID_PATTERN.test(command.orderId))
    || command.refundId === command.paymentId || command.refundId === command.orderId
    || command.paymentId === command.orderId
    || !Number.isSafeInteger(command.amount) || command.amount <= 0
    || command.amount > MAX_DOWNTOWN_U_PLAN_PRICE_CENTS
    || command.currency !== "USD" || !SQUARE_RESOURCE_ID_PATTERN.test(command.locationId)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(command.updatedAt)
    || Number.isNaN(Date.parse(command.updatedAt))) {
    throw new RefundActivationConflictError();
  }
}

/** One preflight and one definer-capability SELECT; no direct refund DML. */
export class PostgresRefundActivationStore implements RefundActivationStore {
  constructor(
    private readonly pool: Pool,
    private readonly identityPreflight: (pool: Pool) => Promise<void> = assertDowntownURuntimeIdentity,
  ) {}

  async activate(
    claim: ClaimedSquareWebhook,
    command: TrustedRefundCommand,
  ): Promise<{ outcome: "applied" | "reconciliation_required" | "duplicate" }> {
    validateInput(claim, command);
    await this.identityPreflight(this.pool);
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        const result = await client.query<ActivationRow>(`SELECT * FROM public.downtown_u_activate_verified_refund(
          $1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10)`, [
          claim.eventId, claim.claimToken, claim.resourceId, command.refundId,
          command.paymentId, command.orderId ?? null, command.amount, command.currency,
          command.locationId, command.updatedAt,
        ]);
        const outcome = result.rows[0]?.outcome;
        if (result.rowCount !== 1
          || (outcome !== "applied" && outcome !== "reconciliation_required" && outcome !== "duplicate")) {
          throw new Error("PostgreSQL refund activation returned an invalid outcome");
        }
        return { outcome };
      });
    } catch (error) {
      if (knownConflict(error)) throw new RefundActivationConflictError();
      throw error;
    }
  }
}
