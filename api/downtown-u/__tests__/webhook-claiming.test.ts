import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WebhookEventStore } from "../../../server/downtown-u/webhook-event-store";
import { WebhookEventConflictError } from "../../../server/downtown-u/webhook-event-store";
import { createSquareWebhookHandler } from "../../../server/downtown-u/square-webhook";
import { createClaimingProcessor } from "../square-webhook";

describe("production webhook claim processor", () => {
  function storeWith(result: Awaited<ReturnType<WebhookEventStore["claim"]>>): WebhookEventStore {
    return { claim: vi.fn().mockResolvedValue(result), complete: vi.fn(), fail: vi.fn() };
  }
  const claim = { eventId: "evt_1", eventType: "payment.updated", bodyHash: "a".repeat(64), resourceId: "PAY_1" } as const;

  it("marks a new claim failed with its exact token and remains retryable", async () => {
    const store = storeWith({ outcome: "claimed", claimToken: "token", attemptCount: 1 });
    await expect(createClaimingProcessor(store)(claim)).rejects.toThrow(/unavailable/i);
    expect(store.claim).toHaveBeenCalledWith(claim.eventId, claim.eventType, claim.bodyHash);
    expect(store.fail).toHaveBeenCalledWith(claim.eventId, "token", "processor_unavailable", "Webhook processor unavailable");
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("fails a reclaimed event with its new token and attempt", async () => {
    const store = storeWith({ outcome: "claimed", claimToken: "new-token", attemptCount: 2 });
    await expect(createClaimingProcessor(store)(claim)).rejects.toThrow(/unavailable/i);
    expect(store.fail).toHaveBeenCalledWith(claim.eventId, "new-token", "processor_unavailable", "Webhook processor unavailable");
  });

  it.each(["in_progress", "exhausted"] as const)("keeps %s retryable", async (outcome) => {
    await expect(createClaimingProcessor(storeWith({ outcome, attemptCount: outcome === "exhausted" ? 1000 : 1 }))(claim)).rejects.toThrow(/processable/i);
  });

  it("acknowledges only an actually completed duplicate", async () => {
    await expect(createClaimingProcessor(storeWith({ outcome: "duplicate", attemptCount: 1 }))(claim)).resolves.toEqual({ outcome: "duplicate" });
  });

  it("stays retryable if the immediate failure transition itself errors", async () => {
    const store = storeWith({ outcome: "claimed", claimToken: "token", attemptCount: 1 });
    vi.mocked(store.fail).mockRejectedValue(new Error("private database detail"));
    await expect(createClaimingProcessor(store)(claim)).rejects.toThrow("Webhook processor unavailable");
  });

  it("offers a token-bound complete/fail interface to the future payment processor", async () => {
    const store = storeWith({ outcome: "claimed", claimToken: "owned-token", attemptCount: 3 });
    const processor = vi.fn(async (_claimed, acknowledgment) => acknowledgment.complete());
    await expect(createClaimingProcessor(store, processor)(claim)).resolves.toEqual({ outcome: "accepted" });
    expect(processor).toHaveBeenCalledWith(
      { ...claim, claimToken: "owned-token", attemptCount: 3 },
      expect.objectContaining({ complete: expect.any(Function), fail: expect.any(Function) }),
    );
    expect(store.complete).toHaveBeenCalledWith(claim.eventId, "owned-token");
  });

  it("preserves conflict and database errors for the boundary to map safely", async () => {
    const conflict = new WebhookEventConflictError();
    const store = storeWith({ outcome: "duplicate", attemptCount: 1 });
    vi.mocked(store.claim).mockRejectedValueOnce(conflict).mockRejectedValueOnce(new Error("db secret"));
    await expect(createClaimingProcessor(store)(claim)).rejects.toBe(conflict);
    await expect(createClaimingProcessor(store)(claim)).rejects.toThrow("db secret");
  });
});

describe("claim outcome HTTP mapping", () => {
  const key = "test-key";
  const url = "https://example.test/api/downtown-u/square-webhook";
  const rawBody = Buffer.from('{"event_id":"evt_http","type":"payment.updated","version":"2026-08-04","data":{"type":"payment","id":"PAY_1","object":{"payment":{"id":"PAY_1"}}}}');
  const signature = createHmac("sha256", key).update(url).update(rawBody).digest("base64");
  const request = {
    method: "POST",
    headers: { "content-type": "application/json", "x-square-hmacsha256-signature": signature },
    rawBody,
  };

  it.each([
    [{ outcome: "accepted" } as const, 202, { ok: true, accepted: true }],
    [{ outcome: "duplicate" } as const, 200, { ok: true, duplicate: true }],
  ])("keeps injected processor mapping %o unchanged", async (processorResult, status, body) => {
    const handler = createSquareWebhookHandler({ signatureKey: key, notificationUrl: url, processEvent: vi.fn().mockResolvedValue(processorResult) });
    await expect(handler(request)).resolves.toEqual({ status, body });
  });

  it("returns generic 409 for event identity conflict", async () => {
    const handler = createSquareWebhookHandler({ signatureKey: key, notificationUrl: url, processEvent: vi.fn().mockRejectedValue(new WebhookEventConflictError()) });
    await expect(handler(request)).resolves.toEqual({ status: 409, body: { error: "event_conflict" } });
  });

  it.each([
    { outcome: "claimed", claimToken: "token", attemptCount: 1 } as const,
    { outcome: "in_progress", attemptCount: 1 } as const,
    { outcome: "exhausted", attemptCount: 1000 } as const,
  ])("returns generic 503 without sensitive detail for $outcome", async (claimResult) => {
    const store: WebhookEventStore = { claim: vi.fn().mockResolvedValue(claimResult), complete: vi.fn(), fail: vi.fn() };
    const handler = createSquareWebhookHandler({ signatureKey: key, notificationUrl: url, processEvent: createClaimingProcessor(store) });
    await expect(handler(request)).resolves.toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
  });

  it("returns completed duplicate as 200 through the production processor", async () => {
    const store: WebhookEventStore = { claim: vi.fn().mockResolvedValue({ outcome: "duplicate", attemptCount: 2 }), complete: vi.fn(), fail: vi.fn() };
    const handler = createSquareWebhookHandler({ signatureKey: key, notificationUrl: url, processEvent: createClaimingProcessor(store) });
    await expect(handler(request)).resolves.toEqual({ status: 200, body: { ok: true, duplicate: true } });
  });

  it("maps database, configuration, and preflight-style failures to a generic 503", async () => {
    const handler = createSquareWebhookHandler({ signatureKey: key, notificationUrl: url, processEvent: vi.fn().mockRejectedValue(new Error("postgres://user:secret@private")) });
    const response = await handler(request);
    expect(response).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});
