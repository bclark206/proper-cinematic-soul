import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler } from "../create-order";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });

const baseRequest = {
  items: [{ variationId: "var-1", quantity: 1, modifiers: [] }],
  customer: { name: "Test User", phone: "555-1234", email: "test@example.com" },
  tip: 0,
  sourceId: "cnon:card-nonce-ok",
  pickupTime: "asap",
};

function makeEvent(body: Record<string, unknown>) {
  return { body: JSON.stringify(body) };
}

function squareOrderResponse(orderId = "ORDER-123") {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        order: {
          id: orderId,
          total_money: { amount: 1000, currency: "USD" },
        },
      }),
  };
}

function squarePaymentResponse(paymentId = "PAY-456") {
  return {
    ok: true,
    json: () => Promise.resolve({ payment: { id: paymentId } }),
  };
}

beforeEach(() => {
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
  mockFetch.mockReset();
  mockFetch
    .mockResolvedValueOnce(squareOrderResponse())
    .mockResolvedValueOnce(squarePaymentResponse());
});

function getOrderPayload() {
  const callArgs = mockFetch.mock.calls[0];
  return JSON.parse(callArgs[1].body);
}

describe("create-order: delivery fee service charge", () => {
  it("includes Delivery Fee service charge for DELIVERY orders", async () => {
    await handler(makeEvent({ ...baseRequest, orderType: "DELIVERY" }));

    const payload = getOrderPayload();
    const charges = payload.order.service_charges;

    expect(charges).toEqual(
      expect.arrayContaining([
        {
          name: "Delivery Fee",
          amount_money: { amount: 500, currency: "USD" },
          calculation_phase: "SUBTOTAL_PHASE",
        },
      ])
    );
  });

  it("does not include Delivery Fee for PICKUP orders", async () => {
    await handler(makeEvent({ ...baseRequest, orderType: "PICKUP" }));

    const payload = getOrderPayload();
    expect(payload.order.service_charges).toBeUndefined();
  });

  it("does not include Delivery Fee when orderType is omitted", async () => {
    await handler(makeEvent({ ...baseRequest }));

    const payload = getOrderPayload();
    expect(payload.order.service_charges).toBeUndefined();
  });

  it("includes both Delivery Fee and Tip for delivery with tip", async () => {
    await handler(
      makeEvent({ ...baseRequest, orderType: "DELIVERY", tip: 300 })
    );

    const payload = getOrderPayload();
    const charges = payload.order.service_charges;

    expect(charges).toHaveLength(2);
    expect(charges[0]).toEqual({
      name: "Delivery Fee",
      amount_money: { amount: 500, currency: "USD" },
      calculation_phase: "SUBTOTAL_PHASE",
    });
    expect(charges[1]).toEqual({
      name: "Tip",
      amount_money: { amount: 300, currency: "USD" },
      calculation_phase: "SUBTOTAL_PHASE",
    });
  });

  it("includes only Tip for pickup with tip", async () => {
    await handler(
      makeEvent({ ...baseRequest, orderType: "PICKUP", tip: 200 })
    );

    const payload = getOrderPayload();
    const charges = payload.order.service_charges;

    expect(charges).toHaveLength(1);
    expect(charges[0].name).toBe("Tip");
  });
});
