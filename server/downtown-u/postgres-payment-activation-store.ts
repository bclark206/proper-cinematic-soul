import type { Pool } from "pg";
import { normalizeEmail, normalizePhone } from "./identity";
import { getCanonicalPlan } from "./plans";
import { assertDowntownURuntimeIdentity } from "./postgres-runtime-identity";
import { withPostgresTransaction } from "./postgres-transaction";
import {
  PaymentActivationConflictError,
  type ClaimedSquareWebhook,
  type PaymentActivationStore,
} from "./payment-activation";
import type { TrustedEnrollmentCommand } from "./enrollment-service";
import { SQUARE_RESOURCE_ID_PATTERN } from "./square-client";

interface ActivationRow { outcome: string }

function activationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["P0001", "22023", "23503", "23505", "23514"].includes(String(error.code));
}

function validateTrustedInput(claim: ClaimedSquareWebhook, command: TrustedEnrollmentCommand): void {
  let plan;
  try {
    plan = getCanonicalPlan(command.planId);
  } catch {
    throw new PaymentActivationConflictError();
  }
  if (claim.eventType !== "payment.updated" || claim.resourceId !== command.paymentId
    || !SQUARE_RESOURCE_ID_PATTERN.test(command.paymentId)
    || !SQUARE_RESOURCE_ID_PATTERN.test(command.orderId)
    || !SQUARE_RESOURCE_ID_PATTERN.test(command.locationId)
    || command.paymentId === command.orderId
    || command.amount !== plan.priceCents || command.currency !== "USD"
    || command.eligibility !== "pending"
    || (!command.email && !command.phone && !command.squareCustomerId)
    || (command.email !== undefined && normalizeEmail(command.email) !== command.email)
    || (command.phone !== undefined && normalizePhone(command.phone) !== command.phone)
    || (command.squareCustomerId !== undefined && !SQUARE_RESOURCE_ID_PATTERN.test(command.squareCustomerId))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(command.paidAt)
    || Number.isNaN(Date.parse(command.paidAt))) {
    throw new PaymentActivationConflictError();
  }
}

/** The application performs no purchase, student, ledger, or completion DML.
 * One narrow database capability owns and atomically commits activation. */
export class PostgresPaymentActivationStore implements PaymentActivationStore {
  constructor(
    private readonly pool: Pool,
    private readonly identityPreflight: (pool: Pool) => Promise<void> = assertDowntownURuntimeIdentity,
  ) {}

  async activate(claim: ClaimedSquareWebhook, command: TrustedEnrollmentCommand): Promise<{ outcome: "activated" | "duplicate" }> {
    validateTrustedInput(claim, command);
    await this.identityPreflight(this.pool);
    const plan = getCanonicalPlan(command.planId);
    try {
      return await withPostgresTransaction(this.pool, async (client) => {
        const result = await client.query<ActivationRow>(`SELECT * FROM public.downtown_u_activate_verified_payment(
          $1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
          claim.eventId, claim.claimToken, claim.resourceId, command.paymentId,
          command.orderId, plan.id, plan.credits, plan.priceCents, command.currency,
          command.locationId, command.paidAt, command.email ?? null,
          command.phone ?? null, command.squareCustomerId ?? null,
        ]);
        const outcome = result.rows[0]?.outcome;
        if (result.rowCount !== 1 || (outcome !== "activated" && outcome !== "duplicate")) {
          throw new Error("PostgreSQL payment activation returned an invalid outcome");
        }
        return { outcome };
      });
    } catch (error) {
      if (activationConflict(error)) throw new PaymentActivationConflictError();
      throw error;
    }
  }
}
