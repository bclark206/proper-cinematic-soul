import {
  EnrollmentValidationError,
  type TrustedEnrollmentCommand,
  type TrustedRefundCommand,
} from "./enrollment-service";
import { SquareApiError } from "./square-client";
import type { SquareWebhookClaim } from "./square-webhook";

export interface ClaimedSquareWebhook extends SquareWebhookClaim {
  claimToken: string;
  attemptCount: number;
}

export interface PaymentActivationStore {
  /** Persists student, purchase, grant, and claim completion in one transaction. */
  activate(
    claim: ClaimedSquareWebhook,
    command: TrustedEnrollmentCommand,
  ): Promise<{ outcome: "activated" | "duplicate" }>;
}

export interface RefundActivationStore {
  /** Persists refund application/reconciliation and claim completion in one transaction. */
  activate(
    claim: ClaimedSquareWebhook,
    command: TrustedRefundCommand,
  ): Promise<{ outcome: "applied" | "reconciliation_required" | "duplicate" }>;
}

export interface ClaimAcknowledgment {
  complete(): Promise<void>;
  fail(failureCode: string, failureDetail: string): Promise<void>;
  reject(failureCode: string, failureDetail: string): Promise<void>;
}

export interface AtomicClaimCompletion { claimCompletedAtomically: true; }
export interface TerminalClaimRejection { claimRejected: true; }

export class PaymentActivationConflictError extends Error {
  constructor() {
    super("Verified payment conflicts with existing records");
    this.name = "PaymentActivationConflictError";
  }
}

export class RefundActivationConflictError extends Error {
  constructor() {
    super("Verified refund conflicts with existing records");
    this.name = "RefundActivationConflictError";
  }
}

export class PaymentClaimProcessingError extends Error {
  constructor(cause?: unknown) {
    super("Payment claim processing failed", cause === undefined ? undefined : { cause });
    this.name = "PaymentClaimProcessingError";
  }
}

interface EnrollmentValidator {
  validatePaymentUpdated(resourceId: string): Promise<TrustedEnrollmentCommand>;
  validateRefundUpdated?(resourceId: string): Promise<TrustedRefundCommand>;
}

interface PaymentClaimProcessorDependencies {
  enrollment: EnrollmentValidator;
  store: PaymentActivationStore;
  refundStore?: RefundActivationStore;
}

async function failRetryably(
  acknowledgment: ClaimAcknowledgment,
  failureCode: string,
  failureDetail: string,
  cause: unknown,
): Promise<never> {
  try {
    await acknowledgment.fail(failureCode, failureDetail);
  } catch (transitionFailure) {
    throw new PaymentClaimProcessingError(transitionFailure);
  }
  throw new PaymentClaimProcessingError(cause);
}

async function rejectPermanently(
  acknowledgment: ClaimAcknowledgment,
  failureCode: string,
  failureDetail: string,
): Promise<TerminalClaimRejection> {
  try {
    await acknowledgment.reject(failureCode, failureDetail);
  } catch (error) {
    throw new PaymentClaimProcessingError(error);
  }
  return { claimRejected: true };
}

/** Performs all Square I/O before the single atomic local capability call. */
export function createPaymentClaimProcessor(dependencies: PaymentClaimProcessorDependencies) {
  return async (
    claim: ClaimedSquareWebhook,
    acknowledgment: ClaimAcknowledgment,
  ): Promise<AtomicClaimCompletion | TerminalClaimRejection> => {
    if (claim.eventType !== "payment.updated" && claim.eventType !== "refund.updated") {
      return rejectPermanently(
        acknowledgment, "unsupported_event", "Webhook event is not supported by this processor",
      );
    }

    if (claim.eventType === "refund.updated") {
      if (!dependencies.enrollment.validateRefundUpdated || !dependencies.refundStore) {
        return rejectPermanently(
          acknowledgment, "unsupported_event", "Webhook event is not supported by this processor",
        );
      }
      let command: TrustedRefundCommand;
      try {
        command = await dependencies.enrollment.validateRefundUpdated(claim.resourceId);
      } catch (error) {
        if (error instanceof SquareApiError && error.kind === "transient") {
          return failRetryably(
            acknowledgment, "square_temporarily_unavailable", "Square validation temporarily unavailable", error,
          );
        }
        if (error instanceof EnrollmentValidationError
          || (error instanceof SquareApiError && error.kind === "permanent")) {
          return rejectPermanently(
            acknowledgment, "refund_validation_failed", "Authoritative refund validation failed",
          );
        }
        throw new PaymentClaimProcessingError(error);
      }
      try {
        await dependencies.refundStore.activate(claim, command);
      } catch (error) {
        if (error instanceof RefundActivationConflictError) {
          return rejectPermanently(
            acknowledgment, "refund_activation_conflict", "Verified refund conflicts with existing records",
          );
        }
        throw new PaymentClaimProcessingError(error);
      }
      return { claimCompletedAtomically: true };
    }

    let command: TrustedEnrollmentCommand;
    try {
      command = await dependencies.enrollment.validatePaymentUpdated(claim.resourceId);
    } catch (error) {
      if (error instanceof SquareApiError && error.kind === "transient") {
        return failRetryably(
          acknowledgment, "square_temporarily_unavailable", "Square validation temporarily unavailable", error,
        );
      }
      if (error instanceof EnrollmentValidationError
        || (error instanceof SquareApiError && error.kind === "permanent")) {
        return rejectPermanently(
          acknowledgment, "payment_validation_failed", "Authoritative payment validation failed",
        );
      }
      throw new PaymentClaimProcessingError(error);
    }

    try {
      await dependencies.store.activate(claim, command);
    } catch (error) {
      if (error instanceof PaymentActivationConflictError) {
        return rejectPermanently(
          acknowledgment, "payment_activation_conflict", "Verified payment conflicts with existing records",
        );
      }
      throw new PaymentClaimProcessingError(error);
    }
    return { claimCompletedAtomically: true };
  };
}
