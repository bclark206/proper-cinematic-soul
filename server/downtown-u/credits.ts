import { getCanonicalPlan, type DowntownUPlanId } from "./plans";

export type LedgerType = "purchase_grant" | "purchase_refund" | "reservation" | "redemption_reversal";
export type ActorType = "student" | "square_webhook" | "order_service" | "system";
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type LedgerMetadata = JsonObject;

/** Metadata is deliberately small because it is copied into the immutable ledger. */
export const MAX_LEDGER_METADATA_BYTES = 16 * 1024;

export interface PurchaseRecord {
  id: string;
  studentId: string;
  planId: DowntownUPlanId;
  squarePaymentId: string;
  squareOrderId: string;
  sourceEventId: string;
  creditsGranted: number;
  priceCents: number;
  status: "paid" | "partially_refunded" | "refunded";
  refundedCredits: number;
}

export interface RedemptionRecord {
  id: string;
  studentId: string;
  credits: number;
  idempotencyKey: string;
  status: "reserved" | "redeemed" | "reversed" | "cancelled";
  squareOrderId?: string;
}

export interface LedgerEntry {
  id: string;
  studentId: string;
  delta: number;
  resultingBalance: number;
  type: LedgerType;
  idempotencyKey: string;
  reason: string;
  actorType: ActorType;
  actorId: string;
  sourceType: string;
  sourceId: string;
  metadata: LedgerMetadata;
}

export class InsufficientCreditsError extends Error {
  constructor() { super("Insufficient Downtown U credits"); this.name = "InsufficientCreditsError"; }
}
export class IdempotencyConflictError extends Error {
  constructor() { super("Idempotency key was already used for different data"); this.name = "IdempotencyConflictError"; }
}
export class InvalidCreditOperationError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidCreditOperationError"; }
}

function invalidMetadata(): never {
  throw new InvalidCreditOperationError("Metadata must be a plain JSON object containing only JSON values");
}

function canonicalizeJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidMetadata();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") return invalidMetadata();
  if (ancestors.has(value)) return invalidMetadata();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || String(index) !== key || index < 0 || index >= value.length;
      })) return invalidMetadata();
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalidMetadata();
        result.push(canonicalizeJsonValue(descriptor.value, ancestors));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidMetadata();

    const result = Object.create(null) as JsonObject;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return invalidMetadata();
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalidMetadata();
      result[key] = canonicalizeJsonValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** One representation shared by in-memory signatures and PostgreSQL JSONB writes/checks. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Validates and returns a detached, deterministically key-ordered metadata object. */
export function canonicalizeLedgerMetadata(metadata: unknown = {}): LedgerMetadata {
  const canonical = canonicalizeJsonValue(metadata, new Set());
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") return invalidMetadata();
  const object = canonical as JsonObject;
  if (Buffer.byteLength(canonicalJson(object), "utf8") > MAX_LEDGER_METADATA_BYTES) {
    throw new InvalidCreditOperationError(`Metadata exceeds ${MAX_LEDGER_METADATA_BYTES} UTF-8 bytes`);
  }
  return object;
}

export interface CreditStore {
  grantPaidPurchase(input: {
    studentId: string; planId: DowntownUPlanId; credits: number; priceCents: number;
    squarePaymentId: string; squareOrderId: string; sourceEventId: string; actorId: string; metadata?: LedgerMetadata;
  }): Promise<PurchaseRecord>;
  reserve(input: { studentId: string; credits: number; idempotencyKey: string; actorId: string; metadata?: LedgerMetadata }): Promise<RedemptionRecord>;
  redeem(input: { redemptionId: string; squareOrderId: string; actorId: string }): Promise<RedemptionRecord>;
  reverseRedemption(input: { redemptionId: string; idempotencyKey: string; reason: string; actorId: string; metadata?: LedgerMetadata }): Promise<RedemptionRecord>;
  refundPurchase(input: { purchaseId: string; creditsToReverse: number; idempotencyKey: string; actorId: string; metadata?: LedgerMetadata }): Promise<PurchaseRecord>;
}

function requirePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidCreditOperationError("Credits must be a positive integer");
}
function requireNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) throw new InvalidCreditOperationError(`${label} is required`);
}

export class DowntownUCredits {
  constructor(private readonly store: CreditStore) {}

  grantPaidPurchase(input: { studentId: string; planId: DowntownUPlanId; squarePaymentId: string; squareOrderId: string; sourceEventId: string; actorId: string; metadata?: LedgerMetadata }): Promise<PurchaseRecord> {
    requireNonEmpty("Student ID", input.studentId);
    requireNonEmpty("Square payment ID", input.squarePaymentId);
    requireNonEmpty("Square order ID", input.squareOrderId);
    requireNonEmpty("Source event ID", input.sourceEventId);
    requireNonEmpty("Actor ID", input.actorId);
    const plan = getCanonicalPlan(input.planId);
    const metadata = canonicalizeLedgerMetadata(input.metadata);
    return this.store.grantPaidPurchase({ ...input, metadata, planId: plan.id, credits: plan.credits, priceCents: plan.priceCents });
  }

  reserve(input: { studentId: string; credits: number; idempotencyKey: string; actorId: string; metadata?: LedgerMetadata }): Promise<RedemptionRecord> {
    requirePositiveInteger(input.credits);
    requireNonEmpty("Student ID", input.studentId);
    requireNonEmpty("Idempotency key", input.idempotencyKey);
    requireNonEmpty("Actor ID", input.actorId);
    return this.store.reserve({ ...input, metadata: canonicalizeLedgerMetadata(input.metadata) });
  }

  redeem(input: { redemptionId: string; squareOrderId: string; actorId: string }): Promise<RedemptionRecord> {
    requireNonEmpty("Redemption ID", input.redemptionId);
    requireNonEmpty("Square order ID", input.squareOrderId);
    requireNonEmpty("Actor ID", input.actorId);
    return this.store.redeem(input);
  }

  reverseRedemption(input: { redemptionId: string; idempotencyKey: string; reason: string; actorId: string; metadata?: LedgerMetadata }): Promise<RedemptionRecord> {
    requireNonEmpty("Redemption ID", input.redemptionId);
    requireNonEmpty("Idempotency key", input.idempotencyKey);
    requireNonEmpty("Reason", input.reason);
    requireNonEmpty("Actor ID", input.actorId);
    return this.store.reverseRedemption({ ...input, metadata: canonicalizeLedgerMetadata(input.metadata) });
  }

  refundPurchase(input: { purchaseId: string; creditsToReverse: number; idempotencyKey: string; actorId: string; metadata?: LedgerMetadata }): Promise<PurchaseRecord> {
    requirePositiveInteger(input.creditsToReverse);
    requireNonEmpty("Purchase ID", input.purchaseId);
    requireNonEmpty("Idempotency key", input.idempotencyKey);
    requireNonEmpty("Actor ID", input.actorId);
    return this.store.refundPurchase({ ...input, metadata: canonicalizeLedgerMetadata(input.metadata) });
  }
}
