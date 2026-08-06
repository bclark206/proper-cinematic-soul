import { describe, expect, it } from "vitest";
import {
  maskNormalizedEmail,
  maskE164Phone,
  redactOperatorStudent,
} from "../redaction";
import {
  OPERATOR_ACCOUNT_STATUSES,
  OPERATOR_ELIGIBILITY_STATUSES,
  OPERATOR_ROLES,
} from "../types";

describe("operator redaction", () => {
  it("keeps the fixed role contract narrow and immutable", () => {
    expect(OPERATOR_ROLES).toEqual([
      "eligibility_reviewer",
      "reconciliation_operator",
      "credit_adjuster",
      "audit_exporter",
    ]);
    expect(Object.isFrozen(OPERATOR_ROLES)).toBe(true);
    expect(OPERATOR_ACCOUNT_STATUSES).toEqual(["active", "disabled"]);
    expect(Object.isFrozen(OPERATOR_ACCOUNT_STATUSES)).toBe(true);
    expect(OPERATOR_ELIGIBILITY_STATUSES).toEqual([
      "pending",
      "approved",
      "rejected",
      "suspended",
    ]);
    expect(Object.isFrozen(OPERATOR_ELIGIBILITY_STATUSES)).toBe(true);
  });

  it("masks normalized email and E.164 phone without retaining contact prefixes", () => {
    expect(maskNormalizedEmail("student.long@example.edu")).toBe("s***@e***.edu");
    expect(maskNormalizedEmail("a@b.co")).toBe("a***@b***.co");
    expect(maskE164Phone("+14155550199")).toBe("+*******0199");
    expect(maskE164Phone("+442079460123")).toBe("+********0123");
  });

  it("never infers a country-code length at E.164 boundaries", () => {
    expect(maskE164Phone("+71234567")).toBe("+****4567");
    expect(maskE164Phone("+358123456789")).toBe("+********6789");
    expect(maskE164Phone("+123456789012345")).toBe("+***********2345");
    for (const invalid of ["+1234567", "+1234567890123456", "+01234567"]) {
      expect(() => maskE164Phone(invalid)).toThrow("Invalid E.164 phone");
    }
  });

  it("constructs an immutable allowlisted student shape", () => {
    const input = {
      id: "student_opaque_01",
      normalizedEmail: "student.long@example.edu",
      normalizedPhone: "+14155550199",
      eligibilityStatus: "approved",
      createdAt: "2026-08-05T10:20:30.000Z",
      updatedAt: new Date("2026-08-05T11:20:30.000Z"),
      squareAccessToken: "square-secret",
      squareCustomerId: "square-customer-secret",
      verifierDigest: "digest-secret",
      cookie: "session-secret",
      databaseUrl: "postgresql://operator:secret@database/operator",
      notes: "unbounded private note",
      arbitrary: { nested: "must not leak" },
    };

    const result = redactOperatorStudent(input);
    expect(result).toEqual({
      id: "student_opaque_01",
      eligibilityStatus: "approved",
      maskedEmail: "s***@e***.edu",
      maskedPhone: "+*******0199",
      createdAt: "2026-08-05T10:20:30.000Z",
      updatedAt: "2026-08-05T11:20:30.000Z",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/student\.long|14155550199|square|digest|session|postgresql|private|nested/);
  });

  it("omits absent or malformed optional values and rejects invalid required contracts", () => {
    expect(redactOperatorStudent({ id: "opaque", eligibilityStatus: "pending" })).toEqual({
      id: "opaque",
      eligibilityStatus: "pending",
    });
    expect(() => redactOperatorStudent({ id: "opaque", eligibilityStatus: "invented" })).toThrow();
    expect(() => redactOperatorStudent({ id: "", eligibilityStatus: "pending" })).toThrow();
    expect(() => redactOperatorStudent(null)).toThrow();
  });

  it("reads only own data properties without invoking getters or prototype values", () => {
    let getterCalls = 0;
    const prototype = {
      normalizedEmail: "prototype@example.edu",
      normalizedPhone: "+14155550199",
      notes: "prototype note",
    };
    const input = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperties(input, {
      id: { value: "own-id", enumerable: true },
      eligibilityStatus: { value: "suspended", enumerable: true },
      createdAt: { get: () => { getterCalls += 1; return "2026-08-05T10:20:30.000Z"; }, enumerable: true },
      normalizedEmail: { get: () => { getterCalls += 1; return "getter@example.edu"; }, enumerable: true },
      cookie: { get: () => { getterCalls += 1; return "cookie"; }, enumerable: true },
    });

    expect(redactOperatorStudent(input)).toEqual({ id: "own-id", eligibilityStatus: "suspended" });
    expect(getterCalls).toBe(0);
  });

  it("accepts only canonical UTC millisecond timestamps and omits other parseable variants", () => {
    const result = redactOperatorStudent({
      id: "timestamp-id",
      eligibilityStatus: "pending",
      eligibilityReviewedAt: "2026-08-05T10:20:30.123Z",
      approvedAt: new Date("2026-08-05T10:20:30.456Z"),
      rejectedAt: new Date(Number.NaN),
      suspendedAt: "2026-08-05T10:20:30Z",
      createdAt: "2026-08-05T11:20:30.000+01:00",
      updatedAt: "2026-08-05T10:20:30.12Z",
      deletedAt: "2026-08-05T10:20:30.0000Z",
    });

    expect(result).toEqual({
      id: "timestamp-id",
      eligibilityStatus: "pending",
      eligibilityReviewedAt: "2026-08-05T10:20:30.123Z",
      approvedAt: "2026-08-05T10:20:30.456Z",
    });
  });

  it("omits hostile optional timestamps whose prototype checks throw", () => {
    const throwingPrototype = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("hostile getPrototypeOf"); },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const input = {
      id: "hostile-time",
      eligibilityStatus: "pending",
      createdAt: throwingPrototype,
      updatedAt: revocable.proxy,
    };

    expect(() => redactOperatorStudent(input)).not.toThrow();
    expect(redactOperatorStudent(input)).toEqual({
      id: "hostile-time",
      eligibilityStatus: "pending",
    });
  });
});
