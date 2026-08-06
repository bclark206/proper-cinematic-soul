import type { Endpoint, EndpointMap, Filters, ListResponse, OperatorRole, OperatorSession } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|([+-])(\d\d):(\d\d))$/;
const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const roles = ["eligibility_reviewer", "reconciliation_operator", "credit_adjuster", "audit_exporter"] as const;
const limits = { session: 16 * 1024, list: 256 * 1024 };
const filterRules = {
  students: { eligibilityStatus: ["pending", "approved", "rejected", "suspended"], studentId: "uuid" },
  purchases: { status: ["paid", "partially_refunded", "refunded"], studentId: "uuid" },
  redemptions: { status: ["reserved", "redeemed", "reversed", "cancelled"], studentId: "uuid" },
  reconciliation: { state: ["needs_review", "resolved"], category: ["payment_follow_up", "kitchen_follow_up"], studentId: "uuid" },
} as const;
const planEconomics = {
  "flex-5": [5, 6000],
  "scholar-10": [10, 11000],
  "resident-20": [20, 21000],
  "semester-40": [40, 40000],
} as const;

export class OperatorRequestError extends Error {
  constructor(public readonly kind: "session" | "forbidden" | "unavailable") {
    super(kind);
    this.name = "OperatorRequestError";
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function plainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  return Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
    .every((descriptor) => !!descriptor && "value" in descriptor && descriptor.enumerable);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) return false;
  const match = ISO.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [match[1], match[2], match[3], match[4], match[5], match[6], match[8], match[9]].map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (match[7] && (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0))) return false;
  return Number.isFinite(Date.parse(value));
}
function optionalTime(record: Record<string, unknown>, key: string): number | null {
  if (!(key in record)) return null;
  return timestamp(record[key]) ? Date.parse(record[key]) : Number.NaN;
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 2_147_483_647;
}
function member(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}
function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || (point >= 127 && point <= 159);
  });
}
function text(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || hasControl(value)) return false;
  const scalars = Array.from(value).length;
  return scalars >= minimum && scalars <= maximum;
}
function ordered(value: number | null, baseline: number): boolean {
  return value === null || (Number.isFinite(value) && value >= baseline);
}

function validSession(value: unknown): value is OperatorSession {
  if (!exact(value, ["authenticated", "operator", "smsReauthFresh"]) || value.authenticated !== true
    || typeof value.smsReauthFresh !== "boolean" || !exact(value.operator, ["displayName", "roles"])) return false;
  const name = value.operator.displayName;
  const list = value.operator.roles;
  return text(name, 1, 120) && name.trim() === name && plainArray(list) && list.length <= 4
    && new Set(list).size === list.length
    && list.every((role): role is OperatorRole => typeof role === "string" && (roles as readonly string[]).includes(role));
}

function validStudent(raw: unknown): boolean {
  if (!exact(raw, ["id", "eligibilityStatus", "createdAt", "updatedAt"],
    ["maskedEmail", "maskedPhone", "eligibilityReviewedAt", "approvedAt", "rejectedAt", "suspendedAt", "deletedAt"])) return false;
  if (!uuid(raw.id) || !member(raw.eligibilityStatus, ["pending", "approved", "rejected", "suspended"])
    || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt)) return false;
  if (!("maskedEmail" in raw) && !("maskedPhone" in raw)) return false;
  if ("maskedEmail" in raw && (!text(raw.maskedEmail, 7, 254) || !/^[^@\s]\*{3}@[^@\s]\*{3}\.[A-Za-z0-9.-]+$/.test(raw.maskedEmail))) return false;
  if ("maskedPhone" in raw && (!text(raw.maskedPhone, 8, 16) || !/^\+\*{3,11}\d{4}$/.test(raw.maskedPhone))) return false;
  const reviewed = optionalTime(raw, "eligibilityReviewedAt");
  const approved = optionalTime(raw, "approvedAt");
  const rejected = optionalTime(raw, "rejectedAt");
  const suspended = optionalTime(raw, "suspendedAt");
  const deleted = optionalTime(raw, "deletedAt");
  if (![reviewed, approved, rejected, suspended, deleted].every((value) => value === null || Number.isFinite(value))) return false;
  if (raw.eligibilityStatus === "pending") return approved === null && rejected === null && suspended === null;
  if (raw.eligibilityStatus === "approved") return rejected === null && suspended === null;
  if (raw.eligibilityStatus === "rejected") return approved === null && suspended === null;
  return rejected === null;
}

function validPurchase(raw: unknown): boolean {
  if (!exact(raw, ["id", "studentId", "planId", "creditsGranted", "priceCents", "currency", "status", "refundedCredits", "paidAt", "createdAt", "updatedAt"], ["refundedAt"])) return false;
  if (!uuid(raw.id) || !uuid(raw.studentId) || !member(raw.planId, Object.keys(planEconomics)) || raw.currency !== "USD"
    || !member(raw.status, ["paid", "partially_refunded", "refunded"]) || !integer(raw.creditsGranted, 1)
    || !integer(raw.priceCents) || !integer(raw.refundedCredits) || raw.refundedCredits > raw.creditsGranted
    || !timestamp(raw.createdAt) || !timestamp(raw.paidAt) || !timestamp(raw.updatedAt)) return false;
  const economics = planEconomics[raw.planId as keyof typeof planEconomics];
  if (raw.creditsGranted !== economics[0] || raw.priceCents !== economics[1]) return false;
  const created = Date.parse(raw.createdAt);
  const refunded = optionalTime(raw, "refundedAt");
  if (Date.parse(raw.updatedAt) < created || !ordered(refunded, created)) return false;
  if (raw.status === "paid") return raw.refundedCredits === 0 && refunded === null;
  if (raw.status === "partially_refunded") return raw.refundedCredits > 0 && raw.refundedCredits < raw.creditsGranted && refunded !== null;
  return raw.refundedCredits === raw.creditsGranted && refunded !== null;
}

function validRedemption(raw: unknown): boolean {
  if (!exact(raw, ["id", "studentId", "mealName", "credits", "status", "reservedAt", "createdAt", "updatedAt"], ["expiresAt", "redeemedAt", "reversedAt"])) return false;
  if (!uuid(raw.id) || !uuid(raw.studentId) || !text(raw.mealName, 1, 160) || !integer(raw.credits, 1)
    || !member(raw.status, ["reserved", "redeemed", "reversed", "cancelled"]) || !timestamp(raw.createdAt)
    || !timestamp(raw.reservedAt) || !timestamp(raw.updatedAt)) return false;
  const created = Date.parse(raw.createdAt);
  const reserved = Date.parse(raw.reservedAt);
  const expires = optionalTime(raw, "expiresAt");
  const redeemed = optionalTime(raw, "redeemedAt");
  const reversed = optionalTime(raw, "reversedAt");
  if (reserved < created || !ordered(expires, reserved) || Date.parse(raw.updatedAt) < created
    || !ordered(redeemed, reserved) || !ordered(reversed, reserved)) return false;
  if (raw.status === "reserved" || raw.status === "cancelled") return redeemed === null && reversed === null;
  if (raw.status === "redeemed") return redeemed !== null && reversed === null;
  return reversed !== null;
}

function validReconciliation(raw: unknown): boolean {
  if (!exact(raw, ["id", "studentId", "category", "state", "openedAt"], ["resolvedAt"])) return false;
  if (!uuid(raw.id) || !uuid(raw.studentId) || !member(raw.category, ["payment_follow_up", "kitchen_follow_up"])
    || !member(raw.state, ["needs_review", "resolved"]) || !timestamp(raw.openedAt)) return false;
  const resolved = optionalTime(raw, "resolvedAt");
  return ordered(resolved, Date.parse(raw.openedAt)) && ((raw.state === "needs_review") === (resolved === null));
}

function validItem(endpoint: Endpoint, raw: unknown): raw is EndpointMap[Endpoint] {
  if (endpoint === "students") return validStudent(raw);
  if (endpoint === "purchases") return validPurchase(raw);
  if (endpoint === "redemptions") return validRedemption(raw);
  return validReconciliation(raw);
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!/^application\/json; charset=utf-8$/i.test(type)) throw new OperatorRequestError("unavailable");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new OperatorRequestError("unavailable");
  if (!response.body) throw new OperatorRequestError("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error(); }
      chunks.push(chunk.value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OperatorRequestError("unavailable");
  }
}

async function request(path: string, maximum: number, timeout: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    let response: Response;
    try {
      response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
    } catch {
      throw new OperatorRequestError("unavailable");
    }
    if (response.status === 401) throw new OperatorRequestError("session");
    if (response.status === 403) throw new OperatorRequestError("forbidden");
    if (response.status === 503 || !response.ok) throw new OperatorRequestError("unavailable");
    return await boundedJson(response, maximum);
  } finally {
    window.clearTimeout(timer);
  }
}

function invalid(): never { throw new OperatorRequestError("unavailable"); }

export async function readOperatorSession(): Promise<OperatorSession> {
  const value = await request("/api/downtown-u/operator/auth/session", limits.session, 8_000);
  try {
    if (!validSession(value)) invalid();
    const session: OperatorSession = {
      authenticated: true,
      operator: Object.freeze({ displayName: value.operator.displayName, roles: Object.freeze([...value.operator.roles]) as OperatorRole[] }),
      smsReauthFresh: value.smsReauthFresh,
    };
    return Object.freeze(session);
  } catch (error) {
    if (error instanceof OperatorRequestError) throw error;
    return invalid();
  }
}

function validatedFilters<E extends Endpoint>(endpoint: E, filters: Filters): URLSearchParams {
  if (!plain(filters)) return invalid();
  const rules = filterRules[endpoint] as Record<string, readonly string[] | "uuid">;
  if (!rules) return invalid();
  const keys = Object.keys(filters);
  if (keys.some((key) => !(key in rules))) return invalid();
  const params = new URLSearchParams({ limit: "25" });
  for (const key of Object.keys(rules)) {
    if (!(key in filters)) continue;
    const value = filters[key];
    if (typeof value !== "string") return invalid();
    if (value === "") continue;
    const rule = rules[key];
    if (rule === "uuid" ? !uuid(value) : !rule.includes(value)) return invalid();
    params.set(key, value);
  }
  return params;
}

export async function readOperatorList<E extends Endpoint>(endpoint: E, filters: Filters, cursor: string | null): Promise<ListResponse<E>> {
  let params: URLSearchParams;
  try {
    params = validatedFilters(endpoint, filters);
    if (cursor !== null) {
      if (typeof cursor !== "string" || cursor.length > 512 || !CURSOR.test(cursor)) invalid();
      params.set("cursor", cursor);
    }
  } catch {
    return invalid();
  }
  const value = await request(`/api/downtown-u/operator/${endpoint}?${params.toString()}`, limits.list, 10_000);
  try {
    if (!exact(value, ["items", "nextCursor"]) || !plainArray(value.items) || value.items.length > 100
      || !(value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length <= 512 && CURSOR.test(value.nextCursor)))) invalid();
    const ids = new Set<string>();
    const items = value.items.map((item) => {
      if (!validItem(endpoint, item)) return invalid();
      const copy = Object.freeze({ ...item }) as EndpointMap[E];
      if (ids.has(copy.id)) return invalid();
      ids.add(copy.id);
      return copy;
    });
    const nextCursor = value.nextCursor as string | null;
    return Object.freeze({ items: Object.freeze(items) as EndpointMap[E][], nextCursor });
  } catch (error) {
    if (error instanceof OperatorRequestError) throw error;
    return invalid();
  }
}

export { UUID };
