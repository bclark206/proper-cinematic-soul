import { describe, expect, it, vi } from "vitest";
import { EnrollmentValidationError, type TrustedEnrollmentCommand } from "../enrollment-service";
import {
  PaymentActivationConflictError,
  createPaymentClaimProcessor,
  type PaymentActivationStore,
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

  it("terminally rejects unsupported refunds without network or persistence", async () => {
    const subject = setup();
    await expect(subject.processor({ ...paymentClaim, eventType: "refund.updated", resourceId: "REFUND_1" }, subject.acknowledgment))
      .resolves.toEqual({ claimRejected: true });
    expect(subject.validate).not.toHaveBeenCalled();
    expect(subject.activate).not.toHaveBeenCalled();
    expect(subject.acknowledgment.reject).toHaveBeenCalledWith("unsupported_event", "Webhook event is not supported by this processor");
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
