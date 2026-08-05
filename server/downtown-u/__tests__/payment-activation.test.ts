import { describe, expect, it, vi } from "vitest";
import {
  EnrollmentValidationError,
  type TrustedEnrollmentCommand,
  type TrustedRefundCommand,
} from "../enrollment-service";
import {
  PaymentActivationConflictError,
  RefundActivationConflictError,
  createPaymentClaimProcessor,
  type PaymentActivationStore,
  type RefundActivationStore,
} from "../payment-activation";
import { SquareApiError } from "../square-client";

const command: TrustedEnrollmentCommand = {
  paymentId: "PAY_1", orderId: "ORDER_1", planId: "flex-5", amount: 6000,
  currency: "USD", locationId: "LOC_1", email: "student@example.com",
  phone: "+14155550100", squareCustomerId: "CUSTOMER_1",
  paidAt: "2026-08-04T12:00:00.123456789Z", eligibility: "pending",
};
const paymentClaim = {
  eventId: "EVT_1", eventType: "payment.updated" as const, bodyHash: "a".repeat(64),
  resourceId: "PAY_1", claimToken: "11111111-1111-4111-8111-111111111111", attemptCount: 1,
};
const refundCommand: TrustedRefundCommand = {
  refundId: "REFUND_1", paymentId: "PAY_1", orderId: "ORDER_1", amount: 1200,
  currency: "USD", locationId: "LOC_1", updatedAt: "2026-08-05T12:00:00.123456789Z",
};
const refundClaim = {
  ...paymentClaim, eventId: "EVT_REFUND_1", eventType: "refund.updated" as const,
  resourceId: "REFUND_1",
};
function setup(validate = vi.fn().mockResolvedValue(command), activate = vi.fn().mockResolvedValue({ outcome: "activated" })) {
  const store: PaymentActivationStore = { activate };
  const acknowledgment = {
    complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
  };
  return {
    validate, activate, acknowledgment,
    processor: createPaymentClaimProcessor({ enrollment: { validatePaymentUpdated: validate }, store }),
  };
}

function setupRefund(
  validate = vi.fn().mockResolvedValue(refundCommand),
  activate = vi.fn().mockResolvedValue({ outcome: "applied" }),
) {
  const refundStore: RefundActivationStore = { activate };
  const acknowledgment = {
    complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
  };
  return {
    validate, activate, acknowledgment,
    processor: createPaymentClaimProcessor({
      enrollment: { validatePaymentUpdated: vi.fn(), validateRefundUpdated: validate },
      store: { activate: vi.fn() }, refundStore,
    }),
  };
}

describe("verified payment claim processor", () => {
  it("finishes validation before atomic persistence and never separately completes", async () => {
    const sequence: string[] = [];
    const validate = vi.fn(async () => { sequence.push("network-finished"); return command; });
    const activate = vi.fn(async () => { sequence.push("transaction-started"); return { outcome: "activated" as const }; });
    const subject = setup(validate, activate);
    await expect(subject.processor(paymentClaim, subject.acknowledgment)).resolves.toEqual({ claimCompletedAtomically: true });
    expect(sequence).toEqual(["network-finished", "transaction-started"]);
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
    expect(subject.acknowledgment.fail).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
  });

  it.each([
    [new EnrollmentValidationError("contact_conflict")],
    [new SquareApiError("permanent", "private buyer@example.com")],
  ])("terminally rejects known permanent validation and returns a handled marker", async (failure) => {
    const subject = setup(vi.fn().mockRejectedValue(failure));
    await expect(subject.processor(paymentClaim, subject.acknowledgment)).resolves.toEqual({ claimRejected: true });
    expect(subject.activate).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).toHaveBeenCalledWith("payment_validation_failed", "Authoritative payment validation failed");
    expect(JSON.stringify(subject.acknowledgment.reject.mock.calls)).not.toMatch(/buyer@|private/i);
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
  });

  it("maps transient Square failure to one redacted retryable failure", async () => {
    const subject = setup(vi.fn().mockRejectedValue(new SquareApiError("transient", "buyer@example.com token=secret")));
    const error = await subject.processor(paymentClaim, subject.acknowledgment).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "PaymentClaimProcessingError", message: "Payment claim processing failed" });
    expect(subject.acknowledgment.fail).toHaveBeenCalledWith("square_temporarily_unavailable", "Square validation temporarily unavailable");
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
  });

  it("propagates Square configuration failure with its internal cause and no acknowledgment", async () => {
    const failure = new SquareApiError("configuration", "token=super-secret buyer@example.com");
    const subject = setup(vi.fn().mockRejectedValue(failure));
    const error = await subject.processor(paymentClaim, subject.acknowledgment).catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "PaymentClaimProcessingError", message: "Payment claim processing failed", cause: failure,
    });
    expect(subject.acknowledgment.fail).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
    expect((error as Error).message).not.toMatch(/secret|buyer@|token=/i);
  });

  it("terminally rejects activation conflict", async () => {
    const subject = setup(undefined, vi.fn().mockRejectedValue(new PaymentActivationConflictError()));
    await expect(subject.processor(paymentClaim, subject.acknowledgment)).resolves.toEqual({ claimRejected: true });
    expect(subject.acknowledgment.reject).toHaveBeenCalledWith("payment_activation_conflict", "Verified payment conflicts with existing records");
  });

  it("validates an authoritative refund before its atomic transaction and never separately completes", async () => {
    const sequence: string[] = [];
    const subject = setupRefund(
      vi.fn(async (id) => { sequence.push(`network:${id}`); return refundCommand; }),
      vi.fn(async () => { sequence.push("transaction"); return { outcome: "applied" as const }; }),
    );
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .resolves.toEqual({ claimCompletedAtomically: true });
    expect(sequence).toEqual(["network:REFUND_1", "transaction"]);
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
  });

  it.each([
    [new EnrollmentValidationError("refund_not_completed")],
    [new SquareApiError("permanent", "private")],
  ])("terminally rejects permanent refund validation", async (failure) => {
    const subject = setupRefund(vi.fn().mockRejectedValue(failure));
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .resolves.toEqual({ claimRejected: true });
    expect(subject.acknowledgment.reject).toHaveBeenCalledWith(
      "refund_validation_failed", "Authoritative refund validation failed",
    );
    expect(subject.activate).not.toHaveBeenCalled();
  });

  it("makes transient refund validation retryable and preserves its cause", async () => {
    const failure = new SquareApiError("transient", "private");
    const subject = setupRefund(vi.fn().mockRejectedValue(failure));
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .rejects.toMatchObject({ name: "PaymentClaimProcessingError", cause: failure });
    expect(subject.acknowledgment.fail).toHaveBeenCalledWith(
      "square_temporarily_unavailable", "Square validation temporarily unavailable",
    );
  });

  it.each([
    ["validator", new SquareApiError("configuration", "token=private")],
    ["validator", new TypeError("private validator")],
    ["store", new Error("private store")],
  ])("keeps unknown refund %s failures retryable without transitioning the token", async (source, failure) => {
    const subject = source === "validator"
      ? setupRefund(vi.fn().mockRejectedValue(failure))
      : setupRefund(undefined, vi.fn().mockRejectedValue(failure));
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .rejects.toMatchObject({ name: "PaymentClaimProcessingError", cause: failure });
    expect(subject.acknowledgment.fail).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
  });

  it("preserves a failed retry transition rather than pretending the token moved", async () => {
    const subject = setupRefund(vi.fn().mockRejectedValue(new SquareApiError("transient", "private")));
    const transitionFailure = new Error("private transition");
    subject.acknowledgment.fail.mockRejectedValue(transitionFailure);
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .rejects.toMatchObject({ name: "PaymentClaimProcessingError", cause: transitionFailure });
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
  });

  it("terminally rejects a permanent local refund conflict", async () => {
    const subject = setupRefund(undefined, vi.fn().mockRejectedValue(new RefundActivationConflictError()));
    await expect(subject.processor(refundClaim, subject.acknowledgment))
      .resolves.toEqual({ claimRejected: true });
    expect(subject.acknowledgment.reject).toHaveBeenCalledWith(
      "refund_activation_conflict", "Verified refund conflicts with existing records",
    );
  });

  it("does not falsely handle a permanent error when rejection transition fails", async () => {
    const subject = setup(vi.fn().mockRejectedValue(new EnrollmentValidationError("contact_conflict")));
    const transitionFailure = new Error("database secret buyer@example.com");
    subject.acknowledgment.reject.mockRejectedValue(transitionFailure);
    const error = await subject.processor(paymentClaim, subject.acknowledgment).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "PaymentClaimProcessingError", message: "Payment claim processing failed", cause: transitionFailure });
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["validator", new TypeError("buyer@example.com secret invariant")],
    ["store", new Error("postgres://buyer@example.com:secret@private/db")],
  ])("preserves unexpected %s cause without fail/reject misclassification", async (source, failure) => {
    const subject = source === "validator"
      ? setup(vi.fn().mockRejectedValue(failure))
      : setup(undefined, vi.fn().mockRejectedValue(failure));
    const error = await subject.processor(paymentClaim, subject.acknowledgment).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "PaymentClaimProcessingError", message: "Payment claim processing failed", cause: failure });
    expect(subject.acknowledgment.fail).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).not.toHaveBeenCalled();
    expect(subject.acknowledgment.complete).not.toHaveBeenCalled();
    expect((error as Error).message).not.toMatch(/buyer@|secret|postgres:/i);
  });
});
