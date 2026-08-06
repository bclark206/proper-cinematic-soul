import { timingSafeEqual } from "node:crypto";
import type { OperatorAuthCryptography } from "./auth-crypto";
import {
  OPERATOR_READ_ENDPOINTS,
  isCanonicalUuid,
  isIsoTimestamp,
  type OperatorReadEndpoint,
  type ReadFilters,
  type ReadPosition,
} from "./read-types";

export class OperatorReadCursorError extends Error {
  constructor() {
    super("Invalid operator dashboard cursor");
    this.name = "OperatorReadCursorError";
  }
}

function fail(): never {
  throw new OperatorReadCursorError();
}

class OperatorReadCursorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorReadCursorInvariantError";
  }
}

const filterKeys = {
  students: ["eligibilityStatus", "studentId"],
  purchases: ["status", "studentId", "purchaseId"],
  redemptions: ["status", "studentId", "redemptionId"],
  reconciliation: ["state", "category", "studentId", "caseId"],
} as const;

const allowedEnums: Record<string, readonly string[]> = {
  eligibilityStatus: ["pending", "approved", "rejected", "suspended"],
  purchaseStatus: ["paid", "partially_refunded", "refunded"],
  redemptionStatus: ["reserved", "redeemed", "reversed", "cancelled"],
  state: ["needs_review", "resolved"],
  category: ["payment_follow_up", "kitchen_follow_up"],
};

function canonicalFilters(endpoint: OperatorReadEndpoint, raw: ReadFilters): ReadFilters {
  if (
    typeof raw !== "object"
    || raw === null
    || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype
    || Object.getOwnPropertySymbols(raw).length !== 0
  ) fail();

  const expected = filterKeys[endpoint];
  if (Object.keys(raw).join(",") !== expected.join(",")) fail();

  const values: Record<string, string | null> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (
      !descriptor
      || !("value" in descriptor)
      || !descriptor.enumerable
      || (descriptor.value !== null && typeof descriptor.value !== "string")
    ) fail();
    values[key] = descriptor.value as string | null;
  }

  for (const key of ["studentId", "purchaseId", "redemptionId", "caseId"]) {
    const value = values[key];
    if (value !== undefined && value !== null && !isCanonicalUuid(value)) fail();
  }
  for (const key of ["eligibilityStatus", "status", "state", "category"]) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    const enumKey = key === "status"
      ? endpoint === "purchases" ? "purchaseStatus" : "redemptionStatus"
      : key;
    if (!allowedEnums[enumKey].includes(value)) fail();
  }

  if (endpoint === "students") {
    return { eligibilityStatus: values.eligibilityStatus, studentId: values.studentId };
  }
  if (endpoint === "purchases") {
    return { status: values.status, studentId: values.studentId, purchaseId: values.purchaseId };
  }
  if (endpoint === "redemptions") {
    return { status: values.status, studentId: values.studentId, redemptionId: values.redemptionId };
  }
  return {
    state: values.state,
    category: values.category,
    studentId: values.studentId,
    caseId: values.caseId,
  };
}

function canonicalPayload(
  endpoint: OperatorReadEndpoint,
  filters: ReadFilters,
  sessionId: string,
  createdAt: string,
  id: string,
): string {
  return JSON.stringify({
    v: 1,
    endpoint,
    filters: canonicalFilters(endpoint, filters),
    sessionId,
    createdAt,
    id,
  });
}

function checkedDigest(
  crypto: Pick<OperatorAuthCryptography, "digestReadCursor">,
  payload: string,
): Buffer {
  const digest = crypto.digestReadCursor(payload);
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    throw new OperatorReadCursorInvariantError("Invalid read cursor digest result");
  }
  return digest;
}

/**
 * Cursors are MAC authenticated and bound to the endpoint, exact filters, and
 * operator session. They deliberately have no independent expiry: session
 * validation remains the authoritative lifetime check on every list request.
 */
export function createReadCursorCodec(
  crypto: Pick<OperatorAuthCryptography, "digestReadCursor">,
) {
  return Object.freeze({
    encode(
      endpoint: OperatorReadEndpoint,
      filters: ReadFilters,
      sessionId: string,
      createdAt: string,
      id: string,
    ): string {
      let payload: string;
      try {
        if (
          !(OPERATOR_READ_ENDPOINTS as readonly unknown[]).includes(endpoint)
          || !isCanonicalUuid(sessionId)
          || !isCanonicalUuid(id)
          || !isIsoTimestamp(createdAt)
        ) fail();
        payload = canonicalPayload(endpoint, filters, sessionId, createdAt, id);
      } catch (error) {
        if (error instanceof OperatorReadCursorError) throw error;
        return fail();
      }
      const mac = checkedDigest(crypto, payload);
      const token = `${Buffer.from(payload, "utf8").toString("base64url")}.${mac.toString("base64url")}`;
      if (token.length > 512) fail();
      return token;
    },

    decode(
      token: string,
      endpoint: OperatorReadEndpoint,
      filters: ReadFilters,
      sessionId: string,
    ): ReadPosition {
      if (
        typeof token !== "string"
        || token.length < 3
        || token.length > 512
        || !(OPERATOR_READ_ENDPOINTS as readonly unknown[]).includes(endpoint)
        || !isCanonicalUuid(sessionId)
      ) fail();

      const parts = token.split(".");
      if (
        parts.length !== 2
        || !/^[A-Za-z0-9_-]+$/.test(parts[0])
        || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
      ) fail();

      const payloadBytes = Buffer.from(parts[0], "base64url");
      const suppliedMac = Buffer.from(parts[1], "base64url");
      if (
        payloadBytes.toString("base64url") !== parts[0]
        || suppliedMac.toString("base64url") !== parts[1]
        || suppliedMac.length !== 32
      ) fail();

      const payload = payloadBytes.toString("utf8");
      if (!Buffer.from(payload, "utf8").equals(payloadBytes)) fail();
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) return fail();
        throw error;
      }
      if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
        || Object.getPrototypeOf(parsed) !== Object.prototype
      ) fail();

      const envelope = parsed as Record<string, unknown>;
      if (
        Object.keys(envelope).join(",") !== "v,endpoint,filters,sessionId,createdAt,id"
        || envelope.v !== 1
        || envelope.endpoint !== endpoint
        || envelope.sessionId !== sessionId
        || !isIsoTimestamp(envelope.createdAt)
        || !isCanonicalUuid(envelope.id)
      ) fail();

      const canonical = canonicalPayload(
        endpoint,
        filters,
        sessionId,
        envelope.createdAt,
        envelope.id,
      );
      if (payload !== canonical) fail();
      const expectedMac = checkedDigest(crypto, payload);
      if (!timingSafeEqual(suppliedMac, expectedMac)) fail();
      return { createdAt: envelope.createdAt, id: envelope.id };
    },
  });
}
