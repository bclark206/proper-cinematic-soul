import {
  EnrollmentValidationError,
  type TrustedEnrollmentCommand,
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

export interface ClaimAcknowledgment {
  complete(): Promise<void>;
  fail(failureCode: string, failureDetail: string): Promise<void>;
  reject(failureCode: string, failureDetail: string): Promise<void>;
}

export interface AtomicClaimCompletion {
  claimCompletedAtomically: true;
}

export interface TerminalClaimRejection {
  claimRejected: true;
}

export class PaymentActivationConflictError extends Error {
  constructor() {
    super("Verified payment conflicts with existing records");
    this.name = "PaymentActivationConflictError";
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
}

interface PaymentClaimProcessorDependencies {
  enrollment: EnrollmentValidator;
  store: PaymentActivationStore;
}

async function failRetryably(
  acknowledgment: ClaimAcknowledgment,
  failureCode: string,
  failureDetail: string,
): Promise<never> {
  try {
    await acknowledgment.fail(failureCode, failureDetail);
  } catch {
    // The generic retryable boundary response remains authoritative if the
    // token-bound transition races a lease takeover or database outage.
  }
  throw new PaymentClaimProcessingError();
}

async function rejectPermanently(
  acknowledgment: ClaimAcknowledgment,
  failureCode: string,
  failureDetail: string,
): Promise<TerminalClaimRejection> {
  try {
    await acknowledgment.reject(failureCode, failureDetail);
  } catch (error) {
    // A permanent error is handled only after its terminal transition commits.
    throw new PaymentClaimProcessingError(error);
  }
  return { claimRejected: true };
}

/**
 * Performs all Square I/O before calling the atomic local store. It deliberately
 * returns markers telling the claim adapter not to complete the event again.
 */
export function createPaymentClaimProcessor(dependencies: PaymentClaimProcessorDependencies) {
  return async (
    claim: ClaimedSquareWebhook,
    acknowledgment: ClaimAcknowledgment,
  ): Promise<AtomicClaimCompletion | TerminalClaimRejection> => {
    if (claim.eventType !== "payment.updated") {
      return rejectPermanently(
        acknowledgment,
        "unsupported_event",
        "Webhook event is not supported by this processor",
      );
    }

    let command: TrustedEnrollmentCommand;
    try {
      command = await dependencies.enrollment.validatePaymentUpdated(claim.resourceId);
    } catch (error) {
      if (error instanceof SquareApiError && error.kind === "transient") {
        return failRetryably(
          acknowledgment,
          "square_temporarily_unavailable",
          "Square validation temporarily unavailable",
        );
      }
      if (error instanceof EnrollmentValidationError
        || (error instanceof SquareApiError && error.kind === "permanent")) {
        return rejectPermanently(
          acknowledgment,
          "payment_validation_failed",
          "Authoritative payment validation failed",
        );
      }
      // Programming/invariant errors are neither Square outages nor safe DB
      // failures. Preserve the cause internally without acknowledging raw data.
      throw new PaymentClaimProcessingError(error);
    }

    try {
      await dependencies.store.activate(claim, command);
    } catch (error) {
      if (error instanceof PaymentActivationConflictError) {
        return rejectPermanently(
          acknowledgment,
          "payment_activation_conflict",
          "Verified payment conflicts with existing records",
        );
      }
      throw new PaymentClaimProcessingError(error);
    }
    return { claimCompletedAtomically: true };
  };
}
