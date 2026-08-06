import {
  OPERATOR_ELIGIBILITY_STATUSES,
  type OperatorEligibilityStatus,
  type RedactedOperatorStudent,
} from "./types";
import { normalizeEmail, normalizePhone } from "../identity";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ELIGIBILITY_STATUSES = new Set<string>(OPERATOR_ELIGIBILITY_STATUSES);

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function maskNormalizedEmail(value: string): string {
  // This is the application's canonical email invariant from identity.ts, not
  // a claim of complete RFC mailbox validation.
  try {
    if (normalizeEmail(value) !== value) throw new Error("not canonical");
  } catch {
    throw new Error("Invalid normalized email");
  }
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const suffixAt = domain.lastIndexOf(".");
  return `${local[0]}***@${domain[0]}***${domain.slice(suffixAt)}`;
}

export function maskE164Phone(value: string): string {
  // Reuse identity.ts as the canonical E.164 boundary (8–15 digits, nonzero
  // first digit) rather than maintaining a second, drifting phone invariant.
  try {
    if (normalizePhone(value) !== value) throw new Error("not canonical");
  } catch {
    throw new Error("Invalid E.164 phone");
  }
  const digits = value.slice(1);
  const visibleSuffix = digits.slice(-4);
  return `+${"*".repeat(digits.length - 4)}${visibleSuffix}`;
}

function timestamp(value: unknown): string | undefined {
  try {
    if (value instanceof Date) {
      const time = Date.prototype.getTime.call(value);
      return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : undefined;
    }
    if (typeof value !== "string") return undefined;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return undefined;
    const normalized = new Date(time).toISOString();
    return normalized === value ? value : undefined;
  } catch {
    // `instanceof` itself can invoke hostile Proxy getPrototypeOf traps.
    return undefined;
  }
}

function isOperatorEligibilityStatus(value: unknown): value is OperatorEligibilityStatus {
  return typeof value === "string" && ELIGIBILITY_STATUSES.has(value);
}

/**
 * Builds an explicit allowlisted projection. It intentionally does not clone,
 * spread, serialize, or recursively inspect the unknown source object.
 */
export function redactOperatorStudent(input: unknown): RedactedOperatorStudent {
  if (typeof input !== "object" || input === null) throw new Error("Invalid operator student");

  const id = ownDataProperty(input, "id");
  const eligibilityStatus = ownDataProperty(input, "eligibilityStatus");
  if (typeof id !== "string" || !OPAQUE_ID_PATTERN.test(id)
      || !isOperatorEligibilityStatus(eligibilityStatus)) {
    throw new Error("Invalid operator student");
  }

  const result: Mutable<RedactedOperatorStudent> = { id, eligibilityStatus };
  const email = ownDataProperty(input, "normalizedEmail");
  const phone = ownDataProperty(input, "normalizedPhone");
  if (typeof email === "string") {
    try { result.maskedEmail = maskNormalizedEmail(email); } catch { /* omit malformed contact */ }
  }
  if (typeof phone === "string") {
    try { result.maskedPhone = maskE164Phone(phone); } catch { /* omit malformed contact */ }
  }

  for (const key of [
    "eligibilityReviewedAt", "approvedAt", "rejectedAt", "suspendedAt",
    "createdAt", "updatedAt", "deletedAt",
  ] as const) {
    const value = timestamp(ownDataProperty(input, key));
    if (value !== undefined) result[key] = value;
  }

  return Object.freeze(result);
}