export const OPERATOR_READ_ENDPOINTS = [
  "students",
  "purchases",
  "redemptions",
  "reconciliation",
] as const;

export type OperatorReadEndpoint = typeof OPERATOR_READ_ENDPOINTS[number];
export type ReadFilters =
  | { eligibilityStatus: string | null; studentId: string | null }
  | { status: string | null; studentId: string | null; purchaseId: string | null }
  | { status: string | null; studentId: string | null; redemptionId: string | null }
  | { state: string | null; category: string | null; studentId: string | null; caseId: string | null };

export interface ReadPosition {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|([+-])(\d\d):(\d\d))$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) return false;
  const match = ISO.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [match[1], match[2], match[3], match[4], match[5], match[6], match[8], match[9]].map(Number);
  if (
    year < 1
    || month < 1
    || month > 12
    || hour > 23
    || minute > 59
    || second > 59
  ) return false;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (
    match[7]
    && (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0))
  ) return false;
  return Number.isFinite(Date.parse(value));
}

function fail(): never {
  throw new Error("Invalid operator dashboard read item");
}

function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Buffer.isBuffer(value)
  ) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  if (Object.getOwnPropertySymbols(value).length !== 0) return fail();
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const result = record(value);
  const keys = Object.keys(result);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
  }
  return result;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function integer(value: unknown, minimum = 0, maximum = 2_147_483_647): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value !== value.normalize("NFC")
  ) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function timestamp(recordValue: Record<string, unknown>, key: string): number | null {
  if (!Object.hasOwn(recordValue, key)) return null;
  if (!isIsoTimestamp(recordValue[key])) return fail();
  return Date.parse(recordValue[key] as string);
}

function requiredTimestamp(recordValue: Record<string, unknown>, key: string): number {
  const value = timestamp(recordValue, key);
  return value === null ? fail() : value;
}

function notBefore(value: number | null, baseline: number): void {
  if (value !== null && value < baseline) fail();
}

function common(value: Record<string, unknown>): void {
  if (!isCanonicalUuid(value.id)) fail();
}

function validateArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > 101
    || Object.getOwnPropertySymbols(value).length !== 0
  ) return fail();
  const propertyNames = Object.getOwnPropertyNames(value);
  const expectedNames = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
  if (
    propertyNames.length !== expectedNames.length
    || propertyNames.some((name, index) => name !== expectedNames[index])
  ) return fail();
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    items.push(descriptor.value);
  }
  return items;
}

function validateStudent(raw: unknown): Record<string, unknown> {
  const item = exact(
    raw,
    ["id", "eligibilityStatus", "createdAt", "updatedAt"],
    [
      "maskedEmail",
      "maskedPhone",
      "eligibilityReviewedAt",
      "approvedAt",
      "rejectedAt",
      "suspendedAt",
      "deletedAt",
    ],
  );
  common(item);
  if (!member(item.eligibilityStatus, ["pending", "approved", "rejected", "suspended"])) fail();
  if (!Object.hasOwn(item, "maskedEmail") && !Object.hasOwn(item, "maskedPhone")) fail();
  if (
    Object.hasOwn(item, "maskedEmail")
    && (!text(item.maskedEmail, 7, 254)
      || !/^[^@\s]\*{3}@[^@\s]\*{3}\.[A-Za-z0-9.-]+$/.test(item.maskedEmail))
  ) fail();
  if (
    Object.hasOwn(item, "maskedPhone")
    && (!text(item.maskedPhone, 8, 16) || !/^\+\*{3,11}\d{4}$/.test(item.maskedPhone))
  ) fail();

  requiredTimestamp(item, "createdAt");
  requiredTimestamp(item, "updatedAt");
  const reviewed = timestamp(item, "eligibilityReviewedAt");
  const approved = timestamp(item, "approvedAt");
  const rejected = timestamp(item, "rejectedAt");
  const suspended = timestamp(item, "suspendedAt");
  timestamp(item, "deletedAt");

  if (
    item.eligibilityStatus === "pending"
    && (approved !== null || rejected !== null || suspended !== null)
  ) fail();
  if (
    item.eligibilityStatus === "approved"
    && (rejected !== null || suspended !== null)
  ) fail();
  if (
    item.eligibilityStatus === "rejected"
    && (approved !== null || suspended !== null)
  ) fail();
  if (item.eligibilityStatus === "suspended" && rejected !== null) fail();
  return item;
}

function validatePurchase(raw: unknown): Record<string, unknown> {
  const item = exact(
    raw,
    [
      "id",
      "studentId",
      "planId",
      "creditsGranted",
      "priceCents",
      "currency",
      "status",
      "refundedCredits",
      "paidAt",
      "createdAt",
      "updatedAt",
    ],
    ["refundedAt"],
  );
  common(item);
  if (
    !isCanonicalUuid(item.studentId)
    || !member(item.planId, ["flex-5", "scholar-10", "resident-20", "semester-40"])
    || item.currency !== "USD"
    || !member(item.status, ["paid", "partially_refunded", "refunded"])
    || !integer(item.creditsGranted, 1)
    || !integer(item.priceCents, 1)
    || !integer(item.refundedCredits)
    || Number(item.refundedCredits) > Number(item.creditsGranted)
  ) fail();
  const planEconomics = {
    "flex-5": { credits: 5, priceCents: 6000 },
    "scholar-10": { credits: 10, priceCents: 11000 },
    "resident-20": { credits: 20, priceCents: 21000 },
    "semester-40": { credits: 40, priceCents: 40000 },
  } as const;
  const economics = planEconomics[item.planId];
  if (item.creditsGranted !== economics.credits || item.priceCents !== economics.priceCents) fail();

  const created = requiredTimestamp(item, "createdAt");
  requiredTimestamp(item, "paidAt");
  notBefore(requiredTimestamp(item, "updatedAt"), created);
  const refunded = timestamp(item, "refundedAt");
  notBefore(refunded, created);
  if (item.status === "paid" && (item.refundedCredits !== 0 || refunded !== null)) fail();
  if (
    item.status === "partially_refunded"
    && (Number(item.refundedCredits) <= 0
      || item.refundedCredits === item.creditsGranted
      || refunded === null)
  ) fail();
  if (
    item.status === "refunded"
    && (item.refundedCredits !== item.creditsGranted || refunded === null)
  ) fail();
  return item;
}

function validateRedemption(raw: unknown): Record<string, unknown> {
  const item = exact(
    raw,
    [
      "id",
      "studentId",
      "mealName",
      "credits",
      "status",
      "reservedAt",
      "createdAt",
      "updatedAt",
    ],
    ["expiresAt", "redeemedAt", "reversedAt"],
  );
  common(item);
  if (
    !isCanonicalUuid(item.studentId)
    || !text(item.mealName, 1, 160)
    || !integer(item.credits, 1)
    || !member(item.status, ["reserved", "redeemed", "reversed", "cancelled"])
  ) fail();

  const created = requiredTimestamp(item, "createdAt");
  const reserved = requiredTimestamp(item, "reservedAt");
  const expires = timestamp(item, "expiresAt");
  notBefore(reserved, created);
  notBefore(expires, reserved);
  notBefore(requiredTimestamp(item, "updatedAt"), created);
  const redeemed = timestamp(item, "redeemedAt");
  const reversed = timestamp(item, "reversedAt");
  notBefore(redeemed, reserved);
  notBefore(reversed, reserved);
  if (item.status === "reserved" && (redeemed !== null || reversed !== null)) fail();
  if (item.status === "redeemed" && (redeemed === null || reversed !== null)) fail();
  if (item.status === "reversed" && reversed === null) fail();
  return item;
}

function validateReconciliation(raw: unknown): Record<string, unknown> {
  const item = exact(
    raw,
    ["id", "studentId", "category", "state", "openedAt"],
    ["resolvedAt"],
  );
  common(item);
  if (
    !isCanonicalUuid(item.studentId)
    || !member(item.category, ["payment_follow_up", "kitchen_follow_up"])
    || !member(item.state, ["needs_review", "resolved"])
  ) fail();
  const opened = requiredTimestamp(item, "openedAt");
  const resolved = timestamp(item, "resolvedAt");
  notBefore(resolved, opened);
  if ((item.state === "needs_review") !== (resolved === null)) fail();
  return item;
}

export function validateReadItems(
  endpoint: OperatorReadEndpoint,
  value: unknown,
): ReadonlyArray<Record<string, unknown>> {
  if (!(OPERATOR_READ_ENDPOINTS as readonly unknown[]).includes(endpoint)) fail();
  const rawItems = validateArray(value);
  const items = rawItems.map((raw) => {
    let item: Record<string, unknown>;
    if (endpoint === "students") item = validateStudent(raw);
    else if (endpoint === "purchases") item = validatePurchase(raw);
    else if (endpoint === "redemptions") item = validateRedemption(raw);
    else item = validateReconciliation(raw);
    return Object.freeze({ ...item });
  });
  return Object.freeze(items);
}
