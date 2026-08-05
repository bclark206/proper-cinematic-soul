import { normalizeEmail, normalizePhone } from "./identity";
import { getCanonicalPlan, type DowntownUPlanId } from "./plans";
import { SQUARE_RESOURCE_ID_PATTERN, type SquareClient, type SquareResource } from "./square-client";

export type DowntownUSquareCatalog = Record<DowntownUPlanId, string>;

export interface EnrollmentServiceConfig {
  client: SquareClient;
  locationId: string;
  catalogVariationIds: DowntownUSquareCatalog;
}

export interface TrustedEnrollmentCommand {
  paymentId: string;
  orderId: string;
  planId: DowntownUPlanId;
  amount: number;
  currency: "USD";
  locationId: string;
  email?: string;
  phone?: string;
  squareCustomerId?: string;
  paidAt: string;
  eligibility: "pending";
}

export interface TrustedRefundCommand {
  refundId: string;
  paymentId: string;
  orderId?: string;
  amount: number;
  currency: "USD";
  locationId: string;
  updatedAt: string;
}

export class EnrollmentValidationError extends Error {
  constructor(public readonly code: string) {
    super("Square transaction is not eligible");
    this.name = "EnrollmentValidationError";
  }
}

function reject(code: string): never {
  throw new EnrollmentValidationError(code);
}

function plainObject(value: unknown): value is SquareResource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: SquareResource, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

type OptionalOwnData =
  | { present: false }
  | { present: true; value: unknown };

/** Reads a known optional schema key without ever performing property access. */
function strictOptionalOwnData(
  value: SquareResource,
  key: string,
  errorCode = "malformed_resource",
): OptionalOwnData {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor) {
    if (!("value" in descriptor)) reject(errorCode);
    return { present: true, value: descriptor.value };
  }
  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    if (Object.getOwnPropertyDescriptor(prototype, key)) reject(errorCode);
  }
  return { present: false };
}

function requiredString(value: SquareResource, key: string): string {
  const result = own(value, key);
  if (typeof result !== "string" || result.length === 0 || result !== result.trim()) reject("malformed_resource");
  return result;
}

function optionalString(value: SquareResource, key: string): string | undefined {
  const result = strictOptionalOwnData(value, key);
  if (!result.present) return undefined;
  if (typeof result.value !== "string") reject("malformed_resource");
  return result.value.trim() === "" ? undefined : result.value;
}

function resourceId(value: SquareResource, key: string): string {
  const id = requiredString(value, key);
  if (!SQUARE_RESOURCE_ID_PATTERN.test(id)) reject("malformed_resource");
  return id;
}

function optionalResourceId(value: SquareResource, key: string): string | undefined {
  const result = strictOptionalOwnData(value, key);
  if (!result.present) return undefined;
  if (typeof result.value !== "string" || !SQUARE_RESOURCE_ID_PATTERN.test(result.value)) {
    reject("malformed_resource");
  }
  return result.value;
}

function timestamp(value: SquareResource, key: string): string {
  const result = requiredString(value, key);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(result);
  if (!match) reject("malformed_resource");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) reject("malformed_resource");
  return result;
}

function money(value: unknown): { amount: number; currency: string } {
  if (!plainObject(value)) reject("malformed_economics");
  const amount = own(value, "amount");
  const currency = own(value, "currency");
  if (!Number.isSafeInteger(amount) || typeof currency !== "string") reject("malformed_economics");
  return { amount: amount as number, currency };
}

function validateOptionalZeroMoney(value: SquareResource, key: string): void {
  const result = strictOptionalOwnData(value, key, "malformed_economics");
  if (!result.present) return;
  const parsed = money(result.value);
  if (parsed.amount !== 0 || parsed.currency !== "USD") reject("unsupported_adjustment");
}

function ownArray(value: SquareResource, key: string): unknown[] {
  const result = own(value, key);
  if (!Array.isArray(result)) reject("malformed_resource");
  return result;
}

function rejectStructuralAdjustments(value: SquareResource, keys: readonly string[]): void {
  for (const key of keys) {
    const result = strictOptionalOwnData(value, key);
    if (!result.present) continue;
    if (!Array.isArray(result.value)) reject("malformed_resource");
    // Structural adjustments are unsupported even when Square reports zero money:
    // accepting them based on totals alone would make catalog economics ambiguous.
    if (result.value.length !== 0) reject("unsupported_adjustment");
  }
}

function validateConfiguration(config: EnrollmentServiceConfig): void {
  if (
    !SQUARE_RESOURCE_ID_PATTERN.test(config.locationId) ||
    config.client.locationId !== config.locationId
  ) throw new Error("Downtown U Square configuration is invalid");
  const ids = Object.keys(config.catalogVariationIds).length === 4
    ? Object.values(config.catalogVariationIds)
    : [];
  if (ids.length !== 4 || ids.some((id) => !SQUARE_RESOURCE_ID_PATTERN.test(id)) || new Set(ids).size !== 4) {
    throw new Error("Downtown U Square configuration is invalid");
  }
  for (const planId of ["flex-5", "scholar-10", "resident-20", "semester-40"] as const) {
    getCanonicalPlan(planId);
    if (!Object.prototype.hasOwnProperty.call(config.catalogVariationIds, planId)) {
      throw new Error("Downtown U Square configuration is invalid");
    }
  }
}

function addNormalized(
  values: Set<string>,
  raw: string | undefined,
  normalizer: (input: string) => string,
): void {
  if (!raw) return;
  try {
    values.add(normalizer(raw));
  } catch {
    reject("invalid_contact");
  }
}

function addCustomerId(values: Set<string>, resource: SquareResource): void {
  const customerId = optionalString(resource, "customer_id");
  if (!customerId) return;
  if (!SQUARE_RESOURCE_ID_PATTERN.test(customerId)) reject("invalid_contact");
  values.add(customerId);
}

function addRecipientContacts(
  recipient: SquareResource,
  emails: Set<string>,
  phones: Set<string>,
  customerIds: Set<string>,
): void {
  addNormalized(emails, optionalString(recipient, "email_address"), normalizeEmail);
  addNormalized(phones, optionalString(recipient, "phone_number"), normalizePhone);
  addCustomerId(customerIds, recipient);
}

function contacts(payment: SquareResource, order: SquareResource) {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const customerIds = new Set<string>();
  addNormalized(emails, optionalString(payment, "buyer_email_address"), normalizeEmail);
  addCustomerId(customerIds, payment);
  addCustomerId(customerIds, order);

  const detailsByType = {
    PICKUP: "pickup_details",
    SHIPMENT: "shipment_details",
    DELIVERY: "delivery_details",
    IN_STORE: "in_store_details",
  } as const;
  const recognizedDetails = Object.values(detailsByType);
  const fulfillments = strictOptionalOwnData(order, "fulfillments");
  if (fulfillments.present) {
    if (!Array.isArray(fulfillments.value) || fulfillments.value.length > 20) reject("malformed_resource");
    for (const fulfillment of fulfillments.value) {
      if (!plainObject(fulfillment)) reject("malformed_resource");
      const type = strictOptionalOwnData(fulfillment, "type");
      const details = new Map<string, unknown>();
      for (const key of recognizedDetails) {
        const result = strictOptionalOwnData(fulfillment, key);
        if (result.present) details.set(key, result.value);
      }
      if (!type.present) {
        if (details.size > 0) reject("malformed_resource");
        continue;
      }
      if (typeof type.value !== "string") reject("malformed_resource");
      const expectedDetailsKey = detailsByType[type.value as keyof typeof detailsByType];
      if (!expectedDetailsKey) {
        if (details.size > 0) reject("malformed_resource");
        continue;
      }
      if (details.size !== 1 || !details.has(expectedDetailsKey)) reject("malformed_resource");

      const selectedDetails = details.get(expectedDetailsKey);
      if (!plainObject(selectedDetails)) reject("malformed_resource");
      const recipientResult = strictOptionalOwnData(selectedDetails, "recipient");
      if (!recipientResult.present) continue;
      const recipient = recipientResult.value;
      if (!plainObject(recipient)) reject("malformed_resource");
      addRecipientContacts(recipient, emails, phones, customerIds);
    }
  }
  if (emails.size > 1 || phones.size > 1 || customerIds.size > 1) reject("contact_conflict");
  const email = [...emails][0];
  const phone = [...phones][0];
  const squareCustomerId = [...customerIds][0];
  if (!email && !phone && !squareCustomerId) reject("contact_missing");
  return { email, phone, squareCustomerId };
}

export function createEnrollmentService(config: EnrollmentServiceConfig) {
  validateConfiguration(config);
  const variationToPlan = new Map<string, DowntownUPlanId>(
    (Object.entries(config.catalogVariationIds) as [DowntownUPlanId, string][]).map(([plan, id]) => [id, plan]),
  );

  async function validatePaymentUpdated(resourceIdValue: string): Promise<TrustedEnrollmentCommand> {
    if (!SQUARE_RESOURCE_ID_PATTERN.test(resourceIdValue)) reject("invalid_resource_id");
    const payment = await config.client.getPayment(resourceIdValue);
    if (!plainObject(payment)) reject("malformed_resource");
    const paymentId = resourceId(payment, "id");
    const orderId = resourceId(payment, "order_id");
    if (paymentId !== resourceIdValue || paymentId === orderId) reject("identity_mismatch");
    if (requiredString(payment, "status") !== "COMPLETED") reject("payment_not_completed");
    if (requiredString(payment, "location_id") !== config.locationId) reject("location_mismatch");
    const paid = money(own(payment, "amount_money"));
    if (paid.amount <= 0 || paid.currency !== "USD") reject("invalid_economics");
    validateOptionalZeroMoney(payment, "tip_money");

    const order = await config.client.getOrder(orderId);
    if (!plainObject(order)) reject("malformed_resource");
    if (resourceId(order, "id") !== orderId) reject("identity_mismatch");
    if (requiredString(order, "location_id") !== config.locationId) reject("location_mismatch");
    // Payment Links may leave a paid order OPEN pending fulfillment. A COMPLETED
    // payment is authoritative settlement, so OPEN and COMPLETED are accepted.
    const state = requiredString(order, "state");
    if (state !== "OPEN" && state !== "COMPLETED") reject("invalid_order_state");
    const lines = ownArray(order, "line_items");
    if (lines.length !== 1 || !plainObject(lines[0])) reject("invalid_line_items");
    const line = lines[0];
    rejectStructuralAdjustments(line, ["modifiers", "applied_taxes", "applied_discounts", "applied_service_charges"]);
    rejectStructuralAdjustments(order, ["taxes", "discounts", "service_charges", "rewards"]);
    for (const key of ["total_tax_money", "total_discount_money", "total_service_charge_money", "total_tip_money"] as const) {
      validateOptionalZeroMoney(line, key);
      validateOptionalZeroMoney(order, key);
    }
    const roundingAdjustment = strictOptionalOwnData(order, "rounding_adjustment");
    if (roundingAdjustment.present) {
      if (!plainObject(roundingAdjustment.value)) reject("malformed_resource");
      reject("unsupported_adjustment");
    }
    const variationId = resourceId(line, "catalog_object_id");
    const planId = variationToPlan.get(variationId);
    if (!planId) reject("unknown_plan");
    const plan = getCanonicalPlan(planId);
    if (requiredString(line, "quantity") !== "1") reject("invalid_line_items");
    const base = money(own(line, "base_price_money"));
    const lineTotal = money(own(line, "total_money"));
    const orderTotal = money(own(order, "total_money"));
    for (const candidate of [paid, base, lineTotal, orderTotal]) {
      if (candidate.amount !== plan.priceCents || candidate.currency !== "USD") reject("invalid_economics");
    }
    const contact = contacts(payment, order);
    return {
      paymentId,
      orderId,
      planId,
      amount: paid.amount,
      currency: "USD",
      locationId: config.locationId,
      ...contact,
      paidAt: timestamp(payment, "created_at"),
      eligibility: "pending",
    };
  }

  async function validateRefundUpdated(resourceIdValue: string): Promise<TrustedRefundCommand> {
    if (!SQUARE_RESOURCE_ID_PATTERN.test(resourceIdValue)) reject("invalid_resource_id");
    const refund = await config.client.getRefund(resourceIdValue);
    if (!plainObject(refund)) reject("malformed_resource");
    const refundId = resourceId(refund, "id");
    // A valid Square refund can omit payment_id, but this command contract
    // intentionally requires payment linkage and updated_at for reconciliation.
    const paymentId = resourceId(refund, "payment_id");
    const orderId = optionalResourceId(refund, "order_id");
    if (refundId !== resourceIdValue || refundId === paymentId || refundId === orderId || paymentId === orderId) {
      reject("identity_mismatch");
    }
    // Square PaymentRefund reaches its successful terminal state at COMPLETED.
    if (requiredString(refund, "status") !== "COMPLETED") reject("refund_not_completed");
    if (requiredString(refund, "location_id") !== config.locationId) reject("location_mismatch");
    const refunded = money(own(refund, "amount_money"));
    if (refunded.amount <= 0 || refunded.currency !== "USD") reject("invalid_economics");
    return {
      refundId,
      paymentId,
      ...(orderId ? { orderId } : {}),
      amount: refunded.amount,
      currency: "USD",
      locationId: config.locationId,
      updatedAt: timestamp(refund, "updated_at"),
    };
  }

  return { validatePaymentUpdated, validateRefundUpdated };
}

export function readDowntownUSquareConfig(env: NodeJS.ProcessEnv): {
  locationId: string;
  catalogVariationIds: DowntownUSquareCatalog;
} {
  const result = {
    locationId: env.SQUARE_LOCATION_ID ?? "",
    catalogVariationIds: {
      "flex-5": env.DOWNTOWN_U_SQUARE_FLEX_5_VARIATION_ID ?? "",
      "scholar-10": env.DOWNTOWN_U_SQUARE_SCHOLAR_10_VARIATION_ID ?? "",
      "resident-20": env.DOWNTOWN_U_SQUARE_RESIDENT_20_VARIATION_ID ?? "",
      "semester-40": env.DOWNTOWN_U_SQUARE_SEMESTER_40_VARIATION_ID ?? "",
    },
  };
  // Reuse the same fail-closed checks without constructing a network client.
  const ids = Object.values(result.catalogVariationIds);
  if (!SQUARE_RESOURCE_ID_PATTERN.test(result.locationId) || ids.some((id) => !SQUARE_RESOURCE_ID_PATTERN.test(id)) || new Set(ids).size !== 4) {
    throw new Error("Downtown U Square configuration is invalid");
  }
  return result;
}
