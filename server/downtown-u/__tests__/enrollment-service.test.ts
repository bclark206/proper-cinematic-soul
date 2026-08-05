import { describe, expect, it, vi } from "vitest";
import {
  createEnrollmentService,
  EnrollmentValidationError,
  readDowntownUSquareConfig,
} from "../enrollment-service";
import { SquareApiError, type SquareClient } from "../square-client";

const catalogVariationIds: Record<"flex-5" | "scholar-10" | "resident-20" | "semester-40", string> = {
  "flex-5": "VAR_FLEX",
  "scholar-10": "VAR_SCHOLAR",
  "resident-20": "VAR_RESIDENT",
  "semester-40": "VAR_SEMESTER",
};
const prices: Record<keyof typeof catalogVariationIds, number> = { "flex-5": 6000, "scholar-10": 11000, "resident-20": 21000, "semester-40": 40000 };

function fixtures(planId: keyof typeof catalogVariationIds = "flex-5") {
  const amount = prices[planId];
  return {
    payment: {
      id: "PAY_1",
      order_id: "ORDER_1",
      status: "COMPLETED",
      location_id: "LOC_1",
      amount_money: { amount, currency: "USD" },
      buyer_email_address: " Student@Example.COM ",
      customer_id: "CUSTOMER_1",
      created_at: "2026-08-04T12:00:00.000Z",
    },
    order: {
      id: "ORDER_1",
      location_id: "LOC_1",
      state: "COMPLETED",
      total_money: { amount, currency: "USD" },
      total_tax_money: { amount: 0, currency: "USD" },
      total_discount_money: { amount: 0, currency: "USD" },
      total_tip_money: { amount: 0, currency: "USD" },
      line_items: [{
        uid: "line_1",
        catalog_object_id: catalogVariationIds[planId],
        quantity: "1",
        base_price_money: { amount, currency: "USD" },
        total_money: { amount, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_discount_money: { amount: 0, currency: "USD" },
      }],
      fulfillments: [{
        type: "PICKUP",
        pickup_details: { recipient: { email_address: "student@example.com", phone_number: "(415) 555-0100" } },
      }],
    },
    refund: {
      id: "REFUND_1",
      status: "COMPLETED",
      amount_money: { amount: 3000, currency: "USD" },
      payment_id: "PAY_1",
      order_id: "ORDER_1",
      location_id: "LOC_1",
      updated_at: "2026-08-05T12:00:00.000Z",
    },
  };
}

function service(overrides: Partial<SquareClient> = {}, mapping = catalogVariationIds) {
  const data = fixtures();
  const client: SquareClient = {
    locationId: "LOC_1",
    getPayment: vi.fn().mockResolvedValue(data.payment),
    getOrder: vi.fn().mockResolvedValue(data.order),
    getRefund: vi.fn().mockResolvedValue(data.refund),
    ...overrides,
  };
  return { client, service: createEnrollmentService({ client, locationId: "LOC_1", catalogVariationIds: mapping }) };
}

async function invalid(promise: Promise<unknown>, code?: string) {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(EnrollmentValidationError);
  if (code) expect(error).toMatchObject({ code });
  expect((error as Error).message).toBe("Square transaction is not eligible");
}

type DescriptorAttack = "own-accessor" | "inherited-data" | "inherited-accessor";

function installDescriptorAttack(
  target: object,
  key: string,
  attack: DescriptorAttack,
  injectedValue: unknown,
): { getter: ReturnType<typeof vi.fn>; restore: () => void } {
  const getter = vi.fn(() => injectedValue);
  if (attack === "own-accessor") {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, enumerable: true, get: getter });
    return {
      getter,
      restore: () => {
        if (previous) Object.defineProperty(target, key, previous);
        else delete (target as Record<string, unknown>)[key];
      },
    };
  }

  delete (target as Record<string, unknown>)[key];
  const prototype = Object.getPrototypeOf(target) as object;
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  Object.defineProperty(prototype, key, attack === "inherited-accessor"
    ? { configurable: true, get: getter }
    : { configurable: true, value: injectedValue });
  return {
    getter,
    restore: () => {
      if (previous) Object.defineProperty(prototype, key, previous);
      else delete (prototype as Record<string, unknown>)[key];
    },
  };
}

describe("authoritative payment enrollment validation", () => {
  it.each(Object.keys(catalogVariationIds) as (keyof typeof catalogVariationIds)[])(
    "derives trusted %s enrollment from fetched payment and order",
    async (planId) => {
      const data = fixtures(planId);
      const { service: subject, client } = service({
        getPayment: vi.fn().mockResolvedValue(data.payment),
        getOrder: vi.fn().mockResolvedValue(data.order),
      });
      await expect(subject.validatePaymentUpdated("PAY_1")).resolves.toEqual({
        paymentId: "PAY_1",
        orderId: "ORDER_1",
        planId,
        amount: prices[planId],
        currency: "USD",
        locationId: "LOC_1",
        email: "student@example.com",
        phone: "+14155550100",
        squareCustomerId: "CUSTOMER_1",
        paidAt: "2026-08-04T12:00:00.000Z",
        eligibility: "pending",
      });
      expect(client.getPayment).toHaveBeenCalledWith("PAY_1");
      expect(client.getOrder).toHaveBeenCalledWith("ORDER_1");
    },
  );

  it("allows OPEN orders because a COMPLETED payment is the settlement authority", async () => {
    const data = fixtures(); data.order.state = "OPEN";
    await expect(service({ getOrder: vi.fn().mockResolvedValue(data.order) }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ paymentId: "PAY_1" });
  });

  it.each([
    "2026-08-04T12:00:00Z",
    "2026-08-04T12:00:00.1Z",
    "2026-08-04T12:00:00.123456789Z",
    "2024-02-29T23:59:59+14:00",
    "2026-01-01T00:00:00-12:34",
  ])("accepts and preserves valid RFC3339 payment created_at %s", async (value) => {
    const data = fixtures(); data.payment.created_at = value;
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ paidAt: value });
  });

  it.each([
    "2026-08-04",
    "08/04/2026 12:00:00",
    "2026-08-04T12:00:00",
    "2026-02-29T12:00:00Z",
    "2024-02-30T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-08-04T24:00:00Z",
    "2026-08-04T12:60:00Z",
    "2026-08-04T12:00:60Z",
    "2026-08-04t12:00:00Z",
    "2026-08-04T12:00:00z",
    "2026-08-04T12:00:00+14:01",
    "2026-08-04T12:00:00+15:00",
    "2026-08-04T12:00:00+0100",
    "2026-08-04T12:00:00. Z",
  ])("rejects non-RFC3339 payment created_at %s", async (value) => {
    const data = fixtures(); data.payment.created_at = value;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it.each([
    ["wrong payment status", (d: ReturnType<typeof fixtures>) => { d.payment.status = "APPROVED"; }],
    ["zero amount", (d: ReturnType<typeof fixtures>) => { d.payment.amount_money.amount = 0; }],
    ["wrong currency", (d: ReturnType<typeof fixtures>) => { d.payment.amount_money.currency = "EUR"; }],
    ["wrong location", (d: ReturnType<typeof fixtures>) => { d.payment.location_id = "OTHER"; }],
    ["wrong order state", (d: ReturnType<typeof fixtures>) => { d.order.state = "CANCELED"; }],
    ["wrong price", (d: ReturnType<typeof fixtures>) => { d.payment.amount_money.amount = 5999; }],
    ["additional line item", (d: ReturnType<typeof fixtures>) => { d.order.line_items.push({ ...d.order.line_items[0], uid: "line_2" }); }],
    ["quantity greater than one", (d: ReturnType<typeof fixtures>) => { d.order.line_items[0].quantity = "2"; }],
    ["tip", (d: ReturnType<typeof fixtures>) => { d.order.total_tip_money.amount = 1; }],
    ["tax", (d: ReturnType<typeof fixtures>) => { d.order.total_tax_money.amount = 1; }],
    ["discount", (d: ReturnType<typeof fixtures>) => { d.order.total_discount_money.amount = 1; }],
    ["unknown catalog variation", (d: ReturnType<typeof fixtures>) => { d.order.line_items[0].catalog_object_id = "UNKNOWN"; }],
  ])("rejects %s", async (_label, mutate) => {
    const data = fixtures(); mutate(data);
    await invalid(service({ getPayment: vi.fn().mockResolvedValue(data.payment), getOrder: vi.fn().mockResolvedValue(data.order) }).service.validatePaymentUpdated("PAY_1"));
  });

  it("rejects missing, mismatched, and reused payment/order IDs", async () => {
    for (const mutate of [
      (d: ReturnType<typeof fixtures>) => { d.payment.order_id = ""; },
      (d: ReturnType<typeof fixtures>) => { d.order.id = "ORDER_2"; },
      (d: ReturnType<typeof fixtures>) => { d.payment.order_id = "PAY_1"; d.order.id = "PAY_1"; },
    ]) {
      const data = fixtures(); mutate(data);
      await invalid(service({ getPayment: vi.fn().mockResolvedValue(data.payment), getOrder: vi.fn().mockResolvedValue(data.order) }).service.validatePaymentUpdated("PAY_1"));
    }
  });

  it("normalizes a single authoritative contact source and rejects conflicts or no route", async () => {
    const onlyCustomer = fixtures();
    delete (onlyCustomer.payment as { buyer_email_address?: string }).buyer_email_address;
    onlyCustomer.order.fulfillments = [];
    await expect(service({ getPayment: vi.fn().mockResolvedValue(onlyCustomer.payment), getOrder: vi.fn().mockResolvedValue(onlyCustomer.order) }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ squareCustomerId: "CUSTOMER_1" });

    const conflict = fixtures(); conflict.order.fulfillments[0].pickup_details.recipient.email_address = "other@example.com";
    await invalid(service({ getPayment: vi.fn().mockResolvedValue(conflict.payment), getOrder: vi.fn().mockResolvedValue(conflict.order) }).service.validatePaymentUpdated("PAY_1"), "contact_conflict");

    const missing = fixtures();
    delete (missing.payment as { buyer_email_address?: string; customer_id?: string }).buyer_email_address;
    delete (missing.payment as { customer_id?: string }).customer_id;
    missing.order.fulfillments = [];
    await invalid(service({ getPayment: vi.fn().mockResolvedValue(missing.payment), getOrder: vi.fn().mockResolvedValue(missing.order) }).service.validatePaymentUpdated("PAY_1"), "contact_missing");
  });

  it.each([
    ["pickup", "PICKUP", "pickup_details"],
    ["shipment", "SHIPMENT", "shipment_details"],
    ["delivery", "DELIVERY", "delivery_details"],
    ["in-store", "IN_STORE", "in_store_details"],
  ])("accepts only the documented %s fulfillment pairing", async (_label, type, detailsKey) => {
    const data = fixtures();
    delete (data.payment as { buyer_email_address?: string; customer_id?: string }).buyer_email_address;
    delete (data.payment as { customer_id?: string }).customer_id;
    data.order.fulfillments = [{
      type,
      [detailsKey]: { recipient: { customer_id: "CUSTOMER_1", email_address: " Student@Example.COM ", phone_number: "(415) 555-0100" } },
    }] as unknown as typeof data.order.fulfillments;
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({
      email: "student@example.com",
      phone: "+14155550100",
      squareCustomerId: "CUSTOMER_1",
    });
  });

  it("accepts a documented fulfillment pair when its optional recipient is absent", async () => {
    const data = fixtures();
    data.order.fulfillments = [{ type: "PICKUP", pickup_details: {} }] as unknown as typeof data.order.fulfillments;
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({
      email: "student@example.com",
      squareCustomerId: "CUSTOMER_1",
    });
  });

  it.each([
    ["missing type with recognized details", { pickup_details: { recipient: { email_address: "student@example.com" } } }],
    ["unsupported DIGITAL type with recognized details", { type: "DIGITAL", pickup_details: { recipient: { email_address: "student@example.com" } } }],
    ["mismatched supported type/details", { type: "PICKUP", shipment_details: { recipient: { email_address: "student@example.com" } } }],
    ["supported type missing its details", { type: "PICKUP" }],
  ])("rejects %s even when payment already supplies authoritative contacts", async (_label, fulfillment) => {
    const data = fixtures();
    data.order.fulfillments = [fulfillment] as unknown as typeof data.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it("fails closed when a supported fulfillment has multiple recognized details containers", async () => {
    const data = fixtures();
    Object.assign(data.order.fulfillments[0], {
      shipment_details: { recipient: { email_address: "injected@example.com" } },
    });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it("rejects inherited and accessor-backed fulfillment types without invoking getters", async () => {
    const inheritedData = fixtures();
    const inherited = Object.create({ type: "PICKUP" }) as Record<string, unknown>;
    inherited.pickup_details = { recipient: { email_address: "student@example.com" } };
    inheritedData.order.fulfillments = [inherited] as unknown as typeof inheritedData.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(inheritedData.payment),
      getOrder: vi.fn().mockResolvedValue(inheritedData.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");

    const accessorData = fixtures();
    const getter = vi.fn(() => "PICKUP");
    const accessor = { pickup_details: { recipient: { email_address: "student@example.com" } } };
    Object.defineProperty(accessor, "type", { enumerable: true, get: getter });
    accessorData.order.fulfillments = [accessor] as unknown as typeof accessorData.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(accessorData.payment),
      getOrder: vi.fn().mockResolvedValue(accessorData.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects inherited and accessor-backed recognized details without invoking getters", async () => {
    const inheritedData = fixtures();
    const inheritedGetter = vi.fn(() => ({ recipient: { email_address: "student@example.com" } }));
    Object.defineProperty(Object.prototype, "pickup_details", { configurable: true, get: inheritedGetter });
    try {
      inheritedData.order.fulfillments = [{ type: "PICKUP" }] as unknown as typeof inheritedData.order.fulfillments;
      await invalid(service({
        getPayment: vi.fn().mockResolvedValue(inheritedData.payment),
        getOrder: vi.fn().mockResolvedValue(inheritedData.order),
      }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
      expect(inheritedGetter).not.toHaveBeenCalled();
    } finally {
      delete (Object.prototype as { pickup_details?: unknown }).pickup_details;
    }

    const accessorData = fixtures();
    const getter = vi.fn(() => ({ recipient: { email_address: "student@example.com" } }));
    const accessor = { type: "PICKUP" };
    Object.defineProperty(accessor, "pickup_details", { enumerable: true, get: getter });
    accessorData.order.fulfillments = [accessor] as unknown as typeof accessorData.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(accessorData.payment),
      getOrder: vi.fn().mockResolvedValue(accessorData.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["null details container", { type: "PICKUP", pickup_details: null }],
    ["null recipient", { type: "PICKUP", pickup_details: { recipient: null } }],
    ["malformed recipient", { type: "PICKUP", pickup_details: { recipient: "student@example.com" } }],
  ])("rejects %s despite an alternate authoritative contact", async (_label, fulfillment) => {
    const data = fixtures();
    data.order.fulfillments = [fulfillment] as unknown as typeof data.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it("rejects an accessor-backed recipient without invoking its getter", async () => {
    const data = fixtures();
    const getter = vi.fn(() => ({ email_address: "student@example.com" }));
    const details = {};
    Object.defineProperty(details, "recipient", { enumerable: true, get: getter });
    data.order.fulfillments = [{ type: "PICKUP", pickup_details: details }] as unknown as typeof data.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not trust fabricated digital_details as an authoritative contact source", async () => {
    const soleDigital = fixtures();
    delete (soleDigital.payment as { buyer_email_address?: string; customer_id?: string }).buyer_email_address;
    delete (soleDigital.payment as { customer_id?: string }).customer_id;
    soleDigital.order.fulfillments = [{
      type: "DIGITAL",
      digital_details: { email_address: "digital@example.com" },
    }] as unknown as typeof soleDigital.order.fulfillments;
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(soleDigital.payment),
      getOrder: vi.fn().mockResolvedValue(soleDigital.order),
    }).service.validatePaymentUpdated("PAY_1"), "contact_missing");

    const alongsideAuthoritative = fixtures();
    alongsideAuthoritative.order.fulfillments.push({
      type: "DIGITAL",
      digital_details: { email_address: "conflicting-fabrication@example.com" },
    } as never);
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(alongsideAuthoritative.payment),
      getOrder: vi.fn().mockResolvedValue(alongsideAuthoritative.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ email: "student@example.com" });
  });

  it("accepts the authoritative order customer ID when it is the only contact route", async () => {
    const data = fixtures();
    delete (data.payment as { buyer_email_address?: string; customer_id?: string }).buyer_email_address;
    delete (data.payment as { customer_id?: string }).customer_id;
    data.order.fulfillments = [];
    Object.assign(data.order, { customer_id: "CUSTOMER_ORDER" });
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ squareCustomerId: "CUSTOMER_ORDER" });
  });

  it.each([
    ["payment versus order", (d: ReturnType<typeof fixtures>) => { Object.assign(d.order, { customer_id: "CUSTOMER_2" }); }],
    ["payment versus recipient", (d: ReturnType<typeof fixtures>) => { Object.assign(d.order.fulfillments[0].pickup_details.recipient, { customer_id: "CUSTOMER_2" }); }],
    ["order versus recipient", (d: ReturnType<typeof fixtures>) => {
      delete (d.payment as { customer_id?: string }).customer_id;
      Object.assign(d.order, { customer_id: "CUSTOMER_1" });
      Object.assign(d.order.fulfillments[0].pickup_details.recipient, { customer_id: "CUSTOMER_2" });
    }],
  ])("rejects customer ID conflict across %s sources", async (_label, mutate) => {
    const data = fixtures(); mutate(data);
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "contact_conflict");
  });

  it.each([
    ["shipment email", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "SHIPMENT", shipment_details: { recipient: { email_address: "other@example.com" } } } as never); }],
    ["delivery email", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "DELIVERY", delivery_details: { recipient: { email_address: "other@example.com" } } } as never); }],
    ["in-store email", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "IN_STORE", in_store_details: { recipient: { email_address: "other@example.com" } } } as never); }],
    ["shipment phone", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "SHIPMENT", shipment_details: { recipient: { phone_number: "+14155550199" } } } as never); }],
    ["delivery phone", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "DELIVERY", delivery_details: { recipient: { phone_number: "+14155550199" } } } as never); }],
    ["in-store phone", (d: ReturnType<typeof fixtures>) => { d.order.fulfillments.push({ type: "IN_STORE", in_store_details: { recipient: { phone_number: "+14155550199" } } } as never); }],
  ])("rejects normalized contact conflict from %s details", async (_label, mutate) => {
    const data = fixtures(); mutate(data);
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "contact_conflict");
  });

  it.each([
    ["line modifiers", "line", "modifiers", [{ uid: "modifier_1", base_price_money: { amount: 0, currency: "USD" }, total_price_money: { amount: 0, currency: "USD" } }]],
    ["line applied taxes", "line", "applied_taxes", [{ uid: "applied_tax_1", tax_uid: "tax_1", applied_money: { amount: 0, currency: "USD" } }]],
    ["line applied discounts", "line", "applied_discounts", [{ uid: "applied_discount_1", discount_uid: "discount_1", applied_money: { amount: 0, currency: "USD" } }]],
    ["line applied service charges", "line", "applied_service_charges", [{ uid: "applied_charge_1", service_charge_uid: "charge_1", applied_money: { amount: 0, currency: "USD" } }]],
    ["order taxes", "order", "taxes", [{ uid: "tax_1", name: "Zero tax", percentage: "0", applied_money: { amount: 0, currency: "USD" } }]],
    ["order discounts", "order", "discounts", [{ uid: "discount_1", name: "Zero discount", percentage: "0", applied_money: { amount: 0, currency: "USD" } }]],
    ["order service charges", "order", "service_charges", [{ uid: "charge_1", name: "Zero charge", percentage: "0", total_money: { amount: 0, currency: "USD" } }]],
    ["order rewards", "order", "rewards", [{ id: "reward_1", reward_tier_id: "tier_1" }]],
  ])("rejects zero-valued structural adjustment: %s", async (_label, scope, key, value) => {
    const data = fixtures();
    const target = scope === "line" ? data.order.line_items[0] : data.order;
    Object.assign(target, { [key]: value });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "unsupported_adjustment");
  });

  it.each([
    ["line modifiers", "line", "modifiers"],
    ["line applied taxes", "line", "applied_taxes"],
    ["line applied discounts", "line", "applied_discounts"],
    ["line applied service charges", "line", "applied_service_charges"],
    ["order taxes", "order", "taxes"],
    ["order discounts", "order", "discounts"],
    ["order service charges", "order", "service_charges"],
    ["order rewards", "order", "rewards"],
  ])("fails closed for malformed non-array adjustment field: %s", async (_label, scope, key) => {
    const data = fixtures();
    const target = scope === "line" ? data.order.line_items[0] : data.order;
    Object.assign(target, { [key]: { amount: 0 } });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it("accepts an explicitly empty applied_service_charges collection", async () => {
    const data = fixtures();
    Object.assign(data.order.line_items[0], { applied_service_charges: [] });
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ paymentId: "PAY_1" });
  });

  it.each(["line", "order"] as const)("accepts an explicit zero USD %s total_service_charge_money", async (scope) => {
    const data = fixtures();
    const target = scope === "line" ? data.order.line_items[0] : data.order;
    Object.assign(target, { total_service_charge_money: { amount: 0, currency: "USD" } });
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ paymentId: "PAY_1" });
  });

  it.each([
    ["line nonzero", "line", { amount: 1, currency: "USD" }, "unsupported_adjustment"],
    ["order nonzero", "order", { amount: 1, currency: "USD" }, "unsupported_adjustment"],
    ["line wrong currency", "line", { amount: 0, currency: "CAD" }, "unsupported_adjustment"],
    ["order wrong currency", "order", { amount: 0, currency: "CAD" }, "unsupported_adjustment"],
    ["line malformed object", "line", { amount: 0 }, "malformed_economics"],
    ["order malformed object", "order", "0 USD", "malformed_economics"],
    ["line malformed amount", "line", { amount: 0.5, currency: "USD" }, "malformed_economics"],
    ["order malformed amount", "order", { amount: "0", currency: "USD" }, "malformed_economics"],
  ] as const)("rejects %s service-charge total", async (_label, scope, value, code) => {
    const data = fixtures();
    const target = scope === "line" ? data.order.line_items[0] : data.order;
    Object.assign(target, { total_service_charge_money: value });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), code);
  });

  it.each(["line", "order"] as const)("rejects inherited and accessor-backed %s service-charge money", async (scope) => {
    const inherited = fixtures();
    const inheritedTarget = scope === "line" ? inherited.order.line_items[0] : inherited.order;
    const inheritedMoney = Object.create({ amount: 0 }) as { amount: number; currency: string };
    inheritedMoney.currency = "USD";
    Object.assign(inheritedTarget, { total_service_charge_money: inheritedMoney });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(inherited.payment),
      getOrder: vi.fn().mockResolvedValue(inherited.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_economics");

    const accessor = fixtures();
    const accessorTarget = scope === "line" ? accessor.order.line_items[0] : accessor.order;
    const getter = vi.fn(() => 0);
    const accessorMoney = { currency: "USD" };
    Object.defineProperty(accessorMoney, "amount", { enumerable: true, get: getter });
    Object.assign(accessorTarget, { total_service_charge_money: accessorMoney });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(accessor.payment),
      getOrder: vi.fn().mockResolvedValue(accessor.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_economics");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects a zero-valued order rounding adjustment independently of totals", async () => {
    const data = fixtures();
    Object.assign(data.order, {
      rounding_adjustment: { uid: "rounding_1", name: "Cash rounding", amount_money: { amount: 0, currency: "USD" } },
    });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "unsupported_adjustment");
  });

  it.each(["own-accessor", "inherited-data", "inherited-accessor"] as const)(
    "rejects %s order fulfillments without invoking accessors despite alternate contacts",
    async (attack) => {
      const data = fixtures();
      const installed = installDescriptorAttack(data.order, "fulfillments", attack, []);
      try {
        await invalid(service({
          getPayment: vi.fn().mockResolvedValue(data.payment),
          getOrder: vi.fn().mockResolvedValue(data.order),
        }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
        expect(installed.getter).not.toHaveBeenCalled();
      } finally {
        installed.restore();
      }
    },
  );

  it("allows true absence of fulfillments but rejects present null or undefined", async () => {
    const absent = fixtures();
    delete (absent.order as { fulfillments?: unknown }).fulfillments;
    await expect(service({
      getPayment: vi.fn().mockResolvedValue(absent.payment),
      getOrder: vi.fn().mockResolvedValue(absent.order),
    }).service.validatePaymentUpdated("PAY_1")).resolves.toMatchObject({ paymentId: "PAY_1" });

    for (const value of [null, undefined]) {
      const present = fixtures();
      Object.defineProperty(present.order, "fulfillments", { configurable: true, enumerable: true, value });
      await invalid(service({
        getPayment: vi.fn().mockResolvedValue(present.payment),
        getOrder: vi.fn().mockResolvedValue(present.order),
      }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
    }
  });

  it.each([
    ["payment buyer email", "payment", "buyer_email_address", "own-accessor"],
    ["payment customer ID", "payment", "customer_id", "inherited-data"],
    ["order customer ID", "order", "customer_id", "inherited-accessor"],
    ["recipient email", "recipient", "email_address", "own-accessor"],
    ["recipient phone", "recipient", "phone_number", "inherited-data"],
    ["recipient customer ID", "recipient", "customer_id", "inherited-accessor"],
  ] as const)("rejects descriptor-unsafe optional contact: %s", async (_label, scope, key, attack) => {
    const data = fixtures();
    const target = scope === "payment" ? data.payment : scope === "order"
      ? data.order : data.order.fulfillments[0].pickup_details.recipient;
    const injected = key === "phone_number" ? "+14155550100" : key === "customer_id" ? "CUSTOMER_1" : "student@example.com";
    const installed = installDescriptorAttack(target, key, attack, injected);
    try {
      await invalid(service({
        getPayment: vi.fn().mockResolvedValue(data.payment),
        getOrder: vi.fn().mockResolvedValue(data.order),
      }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
      expect(installed.getter).not.toHaveBeenCalled();
    } finally {
      installed.restore();
    }
  });

  it.each([
    ["payment buyer email", "payment", "buyer_email_address"],
    ["payment customer ID", "payment", "customer_id"],
    ["order customer ID", "order", "customer_id"],
    ["recipient email", "recipient", "email_address"],
    ["recipient phone", "recipient", "phone_number"],
    ["recipient customer ID", "recipient", "customer_id"],
  ] as const)("rejects present undefined optional contact: %s", async (_label, scope, key) => {
    const data = fixtures();
    const target = scope === "payment" ? data.payment : scope === "order"
      ? data.order : data.order.fulfillments[0].pickup_details.recipient;
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value: undefined });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it.each([
    ["line modifiers", "line", "modifiers", "own-accessor"],
    ["line applied taxes", "line", "applied_taxes", "inherited-data"],
    ["line applied discounts", "line", "applied_discounts", "inherited-accessor"],
    ["line applied service charges", "line", "applied_service_charges", "own-accessor"],
    ["order taxes", "order", "taxes", "inherited-data"],
    ["order discounts", "order", "discounts", "inherited-accessor"],
    ["order service charges", "order", "service_charges", "own-accessor"],
    ["order rewards", "order", "rewards", "inherited-data"],
  ] as const)("rejects descriptor-unsafe structural adjustment: %s", async (_label, scope, key, attack) => {
    const data = fixtures();
    const target = scope === "line" ? data.order.line_items[0] : data.order;
    const installed = installDescriptorAttack(target, key, attack, []);
    try {
      await invalid(service({
        getPayment: vi.fn().mockResolvedValue(data.payment),
        getOrder: vi.fn().mockResolvedValue(data.order),
      }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
      expect(installed.getter).not.toHaveBeenCalled();
    } finally {
      installed.restore();
    }
  });

  it.each([
    ["payment tip", "payment", "tip_money", "own-accessor"],
    ["line tax", "line", "total_tax_money", "inherited-data"],
    ["line discount", "line", "total_discount_money", "inherited-accessor"],
    ["line service charge", "line", "total_service_charge_money", "own-accessor"],
    ["line tip", "line", "total_tip_money", "inherited-data"],
    ["order tax", "order", "total_tax_money", "inherited-accessor"],
    ["order discount", "order", "total_discount_money", "own-accessor"],
    ["order service charge", "order", "total_service_charge_money", "inherited-data"],
    ["order tip", "order", "total_tip_money", "inherited-accessor"],
  ] as const)("rejects descriptor-unsafe optional adjustment money: %s", async (_label, scope, key, attack) => {
    const data = fixtures();
    const target = scope === "payment" ? data.payment : scope === "line" ? data.order.line_items[0] : data.order;
    if (scope === "order" && (key === "total_service_charge_money" || key === "total_tip_money")) {
      Object.assign(data.order.line_items[0], { [key]: { amount: 0, currency: "USD" } });
    }
    const installed = installDescriptorAttack(target, key, attack, { amount: 0, currency: "USD" });
    try {
      await invalid(service({
        getPayment: vi.fn().mockResolvedValue(data.payment),
        getOrder: vi.fn().mockResolvedValue(data.order),
      }).service.validatePaymentUpdated("PAY_1"), "malformed_economics");
      expect(installed.getter).not.toHaveBeenCalled();
    } finally {
      installed.restore();
    }
  });

  it.each([
    ["payment tip", "payment", "tip_money"],
    ["line tax", "line", "total_tax_money"],
    ["line discount", "line", "total_discount_money"],
    ["line service charge", "line", "total_service_charge_money"],
    ["line tip", "line", "total_tip_money"],
    ["order tax", "order", "total_tax_money"],
    ["order discount", "order", "total_discount_money"],
    ["order service charge", "order", "total_service_charge_money"],
    ["order tip", "order", "total_tip_money"],
  ] as const)("rejects present null optional adjustment money: %s", async (_label, scope, key) => {
    const data = fixtures();
    const target = scope === "payment" ? data.payment : scope === "line" ? data.order.line_items[0] : data.order;
    Object.assign(target, { [key]: null });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_economics");
  });

  it.each(["own-accessor", "inherited-data", "inherited-accessor"] as const)(
    "rejects %s rounding adjustment without invoking accessors",
    async (attack) => {
      const data = fixtures();
      const installed = installDescriptorAttack(data.order, "rounding_adjustment", attack, undefined);
      try {
        await invalid(service({
          getPayment: vi.fn().mockResolvedValue(data.payment),
          getOrder: vi.fn().mockResolvedValue(data.order),
        }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
        expect(installed.getter).not.toHaveBeenCalled();
      } finally {
        installed.restore();
      }
    },
  );

  it("rejects present null rounding adjustment", async () => {
    const data = fixtures();
    Object.assign(data.order, { rounding_adjustment: null });
    await invalid(service({
      getPayment: vi.fn().mockResolvedValue(data.payment),
      getOrder: vi.fn().mockResolvedValue(data.order),
    }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
  });

  it("preserves typed generic transient/permanent API errors without sensitive data", async () => {
    for (const kind of ["transient", "permanent"] as const) {
      const upstream = new SquareApiError(kind, kind === "transient" ? "Square API temporarily unavailable" : "Square resource is unavailable");
      const result = service({ getPayment: vi.fn().mockRejectedValue(upstream) }).service.validatePaymentUpdated("PAY_1");
      await expect(result).rejects.toBe(upstream);
      await expect(result).rejects.not.toThrow(/token|buyer@/i);
    }
  });

  it("rejects malformed authoritative resource objects generically", async () => {
    const getter = vi.fn(() => "PAY_1");
    const malformed = { ...fixtures().payment };
    Object.defineProperty(malformed, "id", { get: getter, enumerable: true });
    await invalid(service({ getPayment: vi.fn().mockResolvedValue(malformed) }).service.validatePaymentUpdated("PAY_1"), "malformed_resource");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects duplicate server catalog mappings before API access", () => {
    expect(() => service({}, { ...catalogVariationIds, "scholar-10": "VAR_FLEX" })).toThrow("Downtown U Square configuration is invalid");
  });
});

describe("authoritative refund validation", () => {
  it("returns a minimal trusted completed refund command", async () => {
    await expect(service().service.validateRefundUpdated("REFUND_1")).resolves.toEqual({
      refundId: "REFUND_1", paymentId: "PAY_1", orderId: "ORDER_1", amount: 3000,
      currency: "USD", locationId: "LOC_1", updatedAt: "2026-08-05T12:00:00.000Z",
    });
  });

  it.each([
    "2026-08-05T12:00:00Z",
    "2026-08-05T12:00:00.000001Z",
    "2000-02-29T00:00:00+00:00",
    "2026-08-05T23:59:59-07:30",
  ])("accepts and preserves valid RFC3339 refund updated_at %s", async (value) => {
    const data = fixtures(); data.refund.updated_at = value;
    await expect(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1"))
      .resolves.toMatchObject({ updatedAt: value });
  });

  it.each([
    "2026-08-05",
    "August 5, 2026 12:00 UTC",
    "2026-08-05 12:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-00-05T12:00:00Z",
    "2026-13-05T12:00:00Z",
    "2026-08-05T24:00:00Z",
    "2026-08-05T12:00Z",
    "2026-08-05T12:00:00+12:60",
    "2026-08-05T12:00:00-14:01",
    "2026-08-05T12:00:00Z extra",
  ])("rejects non-RFC3339 refund updated_at %s", async (value) => {
    const data = fixtures(); data.refund.updated_at = value;
    await invalid(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1"), "malformed_resource");
  });

  it("accepts true absence of an own refund order_id and omits it from the command", async () => {
    const data = fixtures();
    delete (data.refund as { order_id?: string }).order_id;
    await expect(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1")).resolves.toEqual({
      refundId: "REFUND_1", paymentId: "PAY_1", amount: 3000,
      currency: "USD", locationId: "LOC_1", updatedAt: "2026-08-05T12:00:00.000Z",
    });
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["invalid characters", "ORDER/1"],
    ["oversized", "x".repeat(193)],
  ])("rejects a present %s refund order_id", async (_label, orderId) => {
    const data = fixtures();
    Object.assign(data.refund, { order_id: orderId });
    await invalid(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1"), "malformed_resource");
  });

  it("rejects inherited-only and accessor-backed refund order_id without invoking getters", async () => {
    const inheritedData = fixtures();
    delete (inheritedData.refund as { order_id?: string }).order_id;
    const inheritedGetter = vi.fn(() => "ORDER_1");
    Object.defineProperty(Object.prototype, "order_id", { configurable: true, get: inheritedGetter });
    try {
      await invalid(service({ getRefund: vi.fn().mockResolvedValue(inheritedData.refund) }).service.validateRefundUpdated("REFUND_1"), "malformed_resource");
      expect(inheritedGetter).not.toHaveBeenCalled();
    } finally {
      delete (Object.prototype as { order_id?: string }).order_id;
    }

    const accessorData = fixtures();
    const getter = vi.fn(() => "ORDER_1");
    Object.defineProperty(accessorData.refund, "order_id", { enumerable: true, get: getter });
    await invalid(service({ getRefund: vi.fn().mockResolvedValue(accessorData.refund) }).service.validateRefundUpdated("REFUND_1"), "malformed_resource");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["nonterminal", (r: ReturnType<typeof fixtures>["refund"]) => { r.status = "PENDING"; }],
    ["wrong currency", (r: ReturnType<typeof fixtures>["refund"]) => { r.amount_money.currency = "CAD"; }],
    ["wrong location", (r: ReturnType<typeof fixtures>["refund"]) => { r.location_id = "OTHER"; }],
    ["zero amount", (r: ReturnType<typeof fixtures>["refund"]) => { r.amount_money.amount = 0; }],
    ["reused ID", (r: ReturnType<typeof fixtures>["refund"]) => { r.id = "PAY_1"; }],
  ])("rejects %s refund", async (_label, mutate) => {
    const data = fixtures(); mutate(data.refund);
    await invalid(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1"));
  });

  it("intentionally rejects an otherwise valid unlinked refund because reconciliation requires payment_id and updated_at", async () => {
    for (const requiredLinkage of ["payment_id", "updated_at"] as const) {
      const data = fixtures();
      delete (data.refund as Record<string, unknown>)[requiredLinkage];
      await invalid(service({ getRefund: vi.fn().mockResolvedValue(data.refund) }).service.validateRefundUpdated("REFUND_1"), "malformed_resource");
    }
  });
});

describe("trusted Square environment configuration", () => {
  it("reads all server-only catalog IDs", () => {
    expect(readDowntownUSquareConfig({
      SQUARE_LOCATION_ID: "LOC_1", DOWNTOWN_U_SQUARE_FLEX_5_VARIATION_ID: "v1",
      DOWNTOWN_U_SQUARE_SCHOLAR_10_VARIATION_ID: "v2", DOWNTOWN_U_SQUARE_RESIDENT_20_VARIATION_ID: "v3",
      DOWNTOWN_U_SQUARE_SEMESTER_40_VARIATION_ID: "v4",
    })).toEqual({ locationId: "LOC_1", catalogVariationIds: { "flex-5": "v1", "scholar-10": "v2", "resident-20": "v3", "semester-40": "v4" } });
  });
});
