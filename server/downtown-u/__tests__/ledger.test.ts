import { beforeEach, describe, expect, it } from "vitest";
import { DowntownUCredits, InsufficientCreditsError, IdempotencyConflictError, InvalidCreditOperationError } from "../credits";
import { InMemoryCreditStore } from "../testing/in-memory-credit-store";

const studentId = "10000000-0000-4000-8000-000000000001";

describe("Downtown U credit operations", () => {
  let store: InMemoryCreditStore;
  let credits: DowntownUCredits;

  beforeEach(() => {
    store = new InMemoryCreditStore();
    store.addStudent(studentId);
    credits = new DowntownUCredits(store);
  });

  it("grants canonical plan credits once for duplicate payment/webhook delivery", async () => {
    const input = {
      studentId,
      planId: "scholar-10",
      squarePaymentId: "payment-1",
      squareOrderId: "order-1",
      sourceEventId: "event-1",
      actorId: "square-webhook",
    } as const;

    const first = await credits.grantPaidPurchase(input);
    const duplicate = await credits.grantPaidPurchase(input);

    expect(first).toEqual(duplicate);
    expect(await store.balance(studentId)).toBe(10);
    expect(store.ledgerFor(studentId)).toHaveLength(1);
    expect(store.ledgerFor(studentId)[0]).toMatchObject({
      delta: 10,
      resultingBalance: 10,
      type: "purchase_grant",
      actorType: "square_webhook",
      actorId: "square-webhook",
      sourceType: "square_payment",
      sourceId: "payment-1",
      metadata: {},
    });
  });

  it("rejects reuse of a source identifier with different purchase data", async () => {
    await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    await expect(credits.grantPaidPurchase({ studentId, planId: "semester-40", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects purchase and reservation retries with changed actor or metadata", async () => {
    const purchase = { studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "webhook-a", metadata: { delivery: 1 } } as const;
    await credits.grantPaidPurchase(purchase);
    await expect(credits.grantPaidPurchase({ ...purchase, actorId: "webhook-b" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(credits.grantPaidPurchase({ ...purchase, metadata: { delivery: 2 } })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const reservation = { studentId, credits: 1, idempotencyKey: "reserve-metadata", actorId: studentId, metadata: { cart: "a" } } as const;
    await credits.reserve(reservation);
    await expect(credits.reserve({ ...reservation, actorId: "different-student-actor" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(credits.reserve({ ...reservation, metadata: { cart: "b" } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects insufficient credits without writing history", async () => {
    await expect(credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-1", actorId: studentId })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await store.balance(studentId)).toBe(0);
    expect(store.ledgerFor(studentId)).toHaveLength(0);
  });

  it("rejects invalid quantities and blank operation identifiers before storage", () => {
    expect(() => credits.reserve({ studentId, credits: 0, idempotencyKey: "reserve-1", actorId: studentId })).toThrow(InvalidCreditOperationError);
    expect(() => credits.reserve({ studentId, credits: 1, idempotencyKey: "   ", actorId: studentId })).toThrow(InvalidCreditOperationError);
    expect(store.ledgerFor(studentId)).toHaveLength(0);
  });

  it("serializes concurrent reservations so credits cannot be double-spent", async () => {
    await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });

    const attempts = await Promise.allSettled([
      credits.reserve({ studentId, credits: 4, idempotencyKey: "reserve-a", actorId: studentId }),
      credits.reserve({ studentId, credits: 4, idempotencyKey: "reserve-b", actorId: studentId }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.balance(studentId)).toBe(1);
  });

  it("makes duplicate reservation calls idempotent", async () => {
    await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const input = { studentId, credits: 2, idempotencyKey: "reserve-1", actorId: studentId };
    const first = await credits.reserve(input);
    const duplicate = await credits.reserve(input);
    expect(first).toEqual(duplicate);
    expect(await store.balance(studentId)).toBe(3);
  });

  it("redeems a reservation without a second debit and reverses it exactly once", async () => {
    await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const reservation = await credits.reserve({ studentId, credits: 2, idempotencyKey: "reserve-1", actorId: studentId });
    await credits.redeem({ redemptionId: reservation.id, squareOrderId: "kitchen-1", actorId: "order-service" });
    expect(await store.balance(studentId)).toBe(3);

    const reversed = await credits.reverseRedemption({ redemptionId: reservation.id, idempotencyKey: "reverse-1", reason: "square_order_failed", actorId: "order-service" });
    const duplicate = await credits.reverseRedemption({ redemptionId: reservation.id, idempotencyKey: "reverse-1", reason: "square_order_failed", actorId: "order-service" });
    expect(reversed).toEqual(duplicate);
    expect(await store.balance(studentId)).toBe(5);
    expect(store.ledgerFor(studentId).map((entry) => entry.delta)).toEqual([5, -2, 2]);
  });

  it("records a refund as a compensating entry and never mutates prior entries", async () => {
    const purchase = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const original = structuredClone(store.ledgerFor(studentId)[0]);
    await credits.refundPurchase({ purchaseId: purchase.id, creditsToReverse: 5, idempotencyKey: "refund-1", actorId: "square-webhook" });
    expect(store.ledgerFor(studentId)[0]).toEqual(original);
    expect(store.ledgerFor(studentId)[1]).toMatchObject({ delta: -5, resultingBalance: 0, type: "purchase_refund" });
    expect(await store.balance(studentId)).toBe(0);
  });

  it("supports stable partial and full refunds", async () => {
    const purchase = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const partialInput = { purchaseId: purchase.id, creditsToReverse: 2, idempotencyKey: "refund-1", actorId: "square-webhook" };
    expect(await credits.refundPurchase(partialInput)).toMatchObject({ status: "partially_refunded", refundedCredits: 2 });
    expect(await credits.refundPurchase(partialInput)).toMatchObject({ status: "partially_refunded", refundedCredits: 2 });
    expect(await credits.refundPurchase({ purchaseId: purchase.id, creditsToReverse: 3, idempotencyKey: "refund-2", actorId: "square-webhook" })).toMatchObject({ status: "refunded", refundedCredits: 5 });
    expect(await store.balance(studentId)).toBe(0);
    expect(store.ledgerFor(studentId)).toHaveLength(3);
  });

  it("rejects conflicting reuse of refund and reversal idempotency keys", async () => {
    const first = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const second = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-2", squareOrderId: "order-2", sourceEventId: "event-2", actorId: "square-webhook" });
    await credits.refundPurchase({ purchaseId: first.id, creditsToReverse: 1, idempotencyKey: "same-refund-key", actorId: "square-webhook" });
    await expect(credits.refundPurchase({ purchaseId: second.id, creditsToReverse: 1, idempotencyKey: "same-refund-key", actorId: "square-webhook" })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const one = await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-1", actorId: studentId });
    const two = await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-2", actorId: studentId });
    await credits.reverseRedemption({ redemptionId: one.id, idempotencyKey: "same-reverse-key", reason: "failed", actorId: "order-service" });
    await expect(credits.reverseRedemption({ redemptionId: two.id, idempotencyKey: "same-reverse-key", reason: "failed", actorId: "order-service" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects reversal and refund retries with changed transaction metadata", async () => {
    const purchase = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const redemption = await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-1", actorId: studentId });
    const reversal = { redemptionId: redemption.id, idempotencyKey: "reverse-metadata", reason: "failed", actorId: "order-service", metadata: { attempt: 1 } } as const;
    await credits.reverseRedemption(reversal);
    await expect(credits.reverseRedemption({ ...reversal, metadata: { attempt: 2 } })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const refund = { purchaseId: purchase.id, creditsToReverse: 1, idempotencyKey: "refund-metadata", actorId: "square-webhook", metadata: { refundId: "a" } } as const;
    await credits.refundPurchase(refund);
    await expect(credits.refundPurchase({ ...refund, metadata: { refundId: "b" } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("does not allow one Square order to finalize two reservations", async () => {
    await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    const one = await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-1", actorId: studentId });
    const two = await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-2", actorId: studentId });
    await credits.redeem({ redemptionId: one.id, squareOrderId: "kitchen-1", actorId: "order-service" });
    await expect(credits.redeem({ redemptionId: two.id, squareOrderId: "kitchen-1", actorId: "order-service" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects refunds that would create a negative available balance", async () => {
    const purchase = await credits.grantPaidPurchase({ studentId, planId: "flex-5", squarePaymentId: "payment-1", squareOrderId: "order-1", sourceEventId: "event-1", actorId: "square-webhook" });
    await credits.reserve({ studentId, credits: 1, idempotencyKey: "reserve-1", actorId: studentId });
    await expect(credits.refundPurchase({ purchaseId: purchase.id, creditsToReverse: 5, idempotencyKey: "refund-1", actorId: "square-webhook" })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await store.balance(studentId)).toBe(4);
  });
});
