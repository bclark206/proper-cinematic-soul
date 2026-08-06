import { createHash } from "node:crypto";
import { normalizeEmail } from "./identity";
import { getCanonicalPlan, type DowntownUPlanId } from "./plans";
import { SQUARE_RESOURCE_ID_PATTERN, SquareApiError, type SquareCheckoutClient, type SquareResource } from "./square-client";
import { EnrollmentValidationError, validateSquarePaymentOrderInvariant, type DowntownUSquareCatalog } from "./enrollment-service";

export const DOWNTOWN_U_LOCATION_ID = "LPPWSSV03BHK8";
export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,45}$/;
export const CHECKOUT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,512}$/;
export type CheckoutState = "started" | "order_created" | "payment_created" | "paid" | "activated" | "operator_review" | "failed";
export class CheckoutRequestError extends Error {
  constructor() { super("invalid_checkout_request"); this.name = "CheckoutRequestError"; }
}
export interface CheckoutAttempt { id: string; idempotencyKey: string; planId: DowntownUPlanId; normalizedEmail: string; state: CheckoutState; squareOrderId?: string; squarePaymentId?: string }
export interface CheckoutStore {
  begin(input: { idempotencyKey: string; planId: DowntownUPlanId; normalizedEmail: string; requestActor: Buffer }): Promise<CheckoutAttempt>;
  recordOrder(id: string, orderId: string): Promise<CheckoutAttempt>;
  recordPayment(id: string, paymentId: string): Promise<CheckoutAttempt>;
  transition(id: string, state: "paid" | "operator_review" | "failed"): Promise<CheckoutAttempt>;
  readPublic(id: string): Promise<{ state: CheckoutState } | null>;
}
export interface CheckoutConfig { client: SquareCheckoutClient; store: CheckoutStore; locationId: string; catalogVariationIds: DowntownUSquareCatalog }

function own(o: SquareResource, k: string): unknown { const d = Object.getOwnPropertyDescriptor(o, k); return d && "value" in d ? d.value : undefined; }
function object(v: unknown): SquareResource { if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("unverified_square_result"); return v as SquareResource; }
function requiredString(o: SquareResource, k: string): string { const v = own(o, k); if (typeof v !== "string") throw new Error("unverified_square_result"); return v; }
function stable(prefix: string, key: string): string { return `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`; }

function verify(attempt: CheckoutAttempt, payment: SquareResource, order: SquareResource, locationId: string, variation: string, cents: number): void {
  validateSquarePaymentOrderInvariant({ payment, order, locationId,
    expectedPaymentId: attempt.squarePaymentId, expectedOrderId: attempt.squareOrderId,
    expectedVariationId: variation, expectedAmount: cents, expectedEmail: attempt.normalizedEmail,
    expectedReferenceId: `du:${attempt.id}` });
}

export function createCheckoutService(config: CheckoutConfig) {
  if (config.locationId !== DOWNTOWN_U_LOCATION_ID || config.client.locationId !== config.locationId) throw new Error("checkout_configuration");
  return Object.freeze({
    async checkout(input: { planId: unknown; sourceId: unknown; email: unknown; eligibilityConfirmed: unknown; idempotencyKey: unknown; requestActor: Buffer }) {
      const plan = getCanonicalPlan(input.planId);
      if (input.eligibilityConfirmed !== true || typeof input.sourceId !== "string" || !SOURCE_ID_PATTERN.test(input.sourceId)
        || typeof input.idempotencyKey !== "string" || !CHECKOUT_KEY_PATTERN.test(input.idempotencyKey)
        || !Buffer.isBuffer(input.requestActor) || input.requestActor.length !== 32) throw new CheckoutRequestError();
      let email: string; try { email = normalizeEmail(input.email as string); } catch { throw new CheckoutRequestError(); }
      const variation = config.catalogVariationIds[plan.id];
      if (!SQUARE_RESOURCE_ID_PATTERN.test(variation)) throw new Error("checkout_configuration");
      let attempt = await config.store.begin({ idempotencyKey: input.idempotencyKey, planId: plan.id, normalizedEmail: email, requestActor: input.requestActor });
      if (attempt.state === "activated" || attempt.state === "paid" || attempt.state === "failed" || attempt.state === "operator_review") return { attemptId: attempt.id, state: attempt.state };
      let phase: "order" | "payment" | "readback" = attempt.squareOrderId ? (attempt.squarePaymentId ? "readback" : "payment") : "order";
      try {
        if (!attempt.squareOrderId) {
          const order = await config.client.createOrder({ idempotency_key: stable("o", attempt.idempotencyKey), order: {
            location_id: config.locationId, reference_id: `du:${attempt.id}`,
            line_items: [{ catalog_object_id: variation, quantity: "1", base_price_money: { amount: plan.priceCents, currency: "USD" } }],
          } });
          const id = requiredString(order, "id"); if (!SQUARE_RESOURCE_ID_PATTERN.test(id)) throw new Error("unverified_square_result");
          attempt = await config.store.recordOrder(attempt.id, id);
        }
        phase = "payment";
        if (!attempt.squarePaymentId) {
          const payment = await config.client.createPayment({ idempotency_key: stable("p", attempt.idempotencyKey), source_id: input.sourceId,
            order_id: attempt.squareOrderId, amount_money: { amount: plan.priceCents, currency: "USD" }, location_id: config.locationId,
            autocomplete: true, buyer_email_address: email, reference_id: `du:${attempt.id}` });
          const id = requiredString(payment, "id"); if (!SQUARE_RESOURCE_ID_PATTERN.test(id)) throw new Error("unverified_square_result");
          attempt = await config.store.recordPayment(attempt.id, id);
        }
        phase = "readback";
        const [payment, order] = await Promise.all([config.client.getPayment(attempt.squarePaymentId!), config.client.getOrder(attempt.squareOrderId!)]);
        verify(attempt, payment, order, config.locationId, variation, plan.priceCents);
        attempt = await config.store.transition(attempt.id, "paid");
        return { attemptId: attempt.id, state: attempt.state };
      } catch (error) {
        // Only an HTTP rejection which Square classifies before creating a payment
        // is safe to retry with a fresh card token/key. Everything ambiguous,
        // including malformed provider success/read-back, remains stable review.
        const definitiveDecline = phase === "payment" && error instanceof SquareApiError
          && error.kind === "permanent" && (error.status === 400 || error.status === 402 || error.status === 422);
        if (definitiveDecline) attempt = await config.store.transition(attempt.id, "failed");
        else if (phase === "readback" && error instanceof EnrollmentValidationError) {
          attempt = await config.store.transition(attempt.id, "operator_review");
        }
        // Unknown provider or persistence outcomes remain at their last durable
        // resumable state. A repeated exact POST safely reuses Square keys; a
        // persisted payment ID skips create and retries authoritative readback.
        return { attemptId: attempt.id, state: attempt.state };
      }
    },
    status: (id: string) => CHECKOUT_ID_PATTERN.test(id) ? config.store.readPublic(id) : Promise.resolve(null),
  });
}
