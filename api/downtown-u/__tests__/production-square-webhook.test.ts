import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { EnrollmentValidationError, type TrustedEnrollmentCommand } from "../../../server/downtown-u/enrollment-service";
import type { PaymentActivationStore } from "../../../server/downtown-u/payment-activation";
import { SquareApiError, type SquareClient } from "../../../server/downtown-u/square-client";
import type { WebhookEventStore } from "../../../server/downtown-u/webhook-event-store";
import {
  createProductionSquareWebhookHandler,
  type ProductionSquareWebhookBoundaries,
} from "../square-webhook";

const env: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://unused.test/db",
  SQUARE_ACCESS_TOKEN: "not-used",
  SQUARE_API_VERSION: "2026-01-22",
  SQUARE_LOCATION_ID: "LOC_1",
  DOWNTOWN_U_SQUARE_FLEX_5_VARIATION_ID: "VAR_1",
  DOWNTOWN_U_SQUARE_SCHOLAR_10_VARIATION_ID: "VAR_2",
  DOWNTOWN_U_SQUARE_RESIDENT_20_VARIATION_ID: "VAR_3",
  DOWNTOWN_U_SQUARE_SEMESTER_40_VARIATION_ID: "VAR_4",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "signature-key",
  DOWNTOWN_U_SQUARE_WEBHOOK_URL: "https://example.test/api/downtown-u/square-webhook",
};
const command: TrustedEnrollmentCommand = {
  paymentId: "PAY_1", orderId: "ORDER_1", planId: "flex-5", amount: 6000,
  currency: "USD", locationId: "LOC_1", email: "student@example.com",
  paidAt: "2026-08-04T12:00:00Z", eligibility: "pending",
};
const rawBody = Buffer.from('{"event_id":"EVT_1","type":"payment.updated","version":"2026-08-04","data":{"type":"payment","id":"PAY_1","object":{"payment":{"id":"PAY_1"}}}}');

function request(bytes = rawBody) {
  const signature = createHmac("sha256", env.SQUARE_WEBHOOK_SIGNATURE_KEY!)
    .update(env.DOWNTOWN_U_SQUARE_WEBHOOK_URL!).update(bytes).digest("base64");
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-square-hmacsha256-signature": signature },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}
function response() {
  const result = { status: 0, body: undefined as unknown };
  return {
    result,
    adapter: {
      setHeader: vi.fn(),
      status: (status: number) => ({ json: (body: unknown) => { result.status = status; result.body = body; } }),
    },
  };
}
function boundaries(
  validatePaymentUpdated: () => Promise<TrustedEnrollmentCommand> = async () => command,
  activate = vi.fn().mockResolvedValue({ outcome: "activated" }),
) {
  const pool = {} as Pool;
  const store: WebhookEventStore = {
    claim: vi.fn().mockResolvedValue({ outcome: "claimed", claimToken: "11111111-1111-4111-8111-111111111111", attemptCount: 1 }),
    complete: vi.fn(), fail: vi.fn(), reject: vi.fn(),
  };
  const activation: PaymentActivationStore = { activate };
  const result: ProductionSquareWebhookBoundaries = {
    getPool: vi.fn().mockReturnValue(pool),
    createSquareClient: vi.fn().mockReturnValue({} as SquareClient),
    createEnrollment: vi.fn().mockReturnValue({ validatePaymentUpdated, validateRefundUpdated: vi.fn() }),
    createWebhookStore: vi.fn().mockReturnValue(store),
    createActivationStore: vi.fn().mockReturnValue(activation),
  };
  return { result, store, activation, pool };
}

describe("production Square webhook composition", () => {
  it("returns generic 503 for missing/invalid configuration before consuming the body or creating boundaries", async () => {
    const b = boundaries();
    const read = vi.fn();
    const req = {
      method: "POST", headers: {},
      [Symbol.asyncIterator]() { read(); throw new Error("must not read"); },
    };
    for (const badEnv of [{}, { ...env, SQUARE_LOCATION_ID: "bad symbol" }]) {
      const res = response();
      await createProductionSquareWebhookHandler(badEnv, b.result)(req as never, res.adapter);
      expect(res.result).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
    }
    expect(read).not.toHaveBeenCalled();
    expect(b.result.getPool).not.toHaveBeenCalled();
  });

  it("composes exact injected boundaries and honors atomic completion without a second complete", async () => {
    const b = boundaries();
    const res = response();
    await createProductionSquareWebhookHandler(env, b.result)(request(), res.adapter);
    expect(res.result).toEqual({ status: 202, body: { ok: true, accepted: true } });
    expect(b.result.getPool).toHaveBeenCalledWith(env.DATABASE_URL);
    expect(b.result.createWebhookStore).toHaveBeenCalledWith(b.pool);
    expect(b.result.createActivationStore).toHaveBeenCalledWith(b.pool);
    expect(b.activation.activate).toHaveBeenCalledWith(expect.objectContaining({ eventId: "EVT_1", resourceId: "PAY_1" }), command);
    expect(b.store.complete).not.toHaveBeenCalled();
  });

  it("returns handled 2xx only after permanent rejection succeeds", async () => {
    const b = boundaries(async () => { throw new EnrollmentValidationError("not_paid"); });
    const res = response();
    await createProductionSquareWebhookHandler(env, b.result)(request(), res.adapter);
    expect(res.result).toEqual({ status: 202, body: { ok: true, accepted: true } });
    expect(b.store.reject).toHaveBeenCalledWith("EVT_1", expect.any(String), "payment_validation_failed", "Authoritative payment validation failed");
    expect(b.store.complete).not.toHaveBeenCalled();
  });

  it("maps unknown causes and rejection transition failure to generic 503 without leakage", async () => {
    for (const setup of [
      () => boundaries(async () => { throw new TypeError("buyer@example.com secret invariant"); }),
      () => {
        const b = boundaries(async () => { throw new EnrollmentValidationError("not_paid"); });
        vi.mocked(b.store.reject).mockRejectedValue(new Error("postgres://buyer@example.com:secret@private"));
        return b;
      },
    ]) {
      const b = setup();
      const res = response();
      await createProductionSquareWebhookHandler(env, b.result)(request(), res.adapter);
      expect(res.result).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
      expect(JSON.stringify(res.result)).not.toMatch(/buyer@|secret|postgres:|invariant/i);
      expect(b.store.complete).not.toHaveBeenCalled();
    }
  });

  it("returns generic 503 for a secret-bearing Square configuration error without persisting a disposition", async () => {
    const b = boundaries(async () => {
      throw new SquareApiError("configuration", "token=production-secret buyer@example.com");
    });
    const res = response();
    await createProductionSquareWebhookHandler(env, b.result)(request(), res.adapter);
    expect(res.result).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
    expect(JSON.stringify(res.result)).not.toMatch(/production-secret|buyer@|token=/i);
    expect(b.store.fail).not.toHaveBeenCalled();
    expect(b.store.reject).not.toHaveBeenCalled();
    expect(b.store.complete).not.toHaveBeenCalled();
  });
});
