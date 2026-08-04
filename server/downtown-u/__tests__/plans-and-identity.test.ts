import { describe, expect, it } from "vitest";
import { getCanonicalPlan } from "../plans";
import { normalizeEmail, normalizePhone } from "../identity";
import { StudentAccounts, type StudentAccountStore } from "../student-accounts";

describe("canonical Downtown U plans", () => {
  it.each([
    ["flex-5", 5, 6_000],
    ["scholar-10", 10, 11_000],
    ["resident-20", 20, 21_000],
    ["semester-40", 40, 40_000],
  ] as const)("maps %s on the server", (id, credits, priceCents) => {
    expect(getCanonicalPlan(id)).toEqual({ id, credits, priceCents });
  });

  it("rejects unknown plans instead of trusting supplied economics", () => {
    expect(() => getCanonicalPlan("flex-500")).toThrow("Unknown Downtown U plan");
  });
});

describe("student contact normalization", () => {
  it("normalizes and validates email", () => {
    expect(normalizeEmail("  STUDENT+U@Example.EDU ")).toBe("student+u@example.edu");
    expect(() => normalizeEmail("not-an-email")).toThrow("Invalid email");
  });

  it("normalizes US phone numbers to E.164 and rejects invalid input", () => {
    expect(normalizePhone("(312) 555-0199")).toBe("+13125550199");
    expect(normalizePhone("+1 312 555 0199")).toBe("+13125550199");
    expect(() => normalizePhone("555")).toThrow("Invalid phone");
    expect(() => normalizePhone("++1 312 555 0199")).toThrow("Invalid phone");
    expect(() => normalizePhone("call 3125550199")).toThrow("Invalid phone");
  });

  it("passes only normalized contact data to the student repository", async () => {
    let received: Parameters<StudentAccountStore["upsert"]>[0] | undefined;
    const store: StudentAccountStore = {
      async upsert(input) {
        received = input;
        return { id: "student-1", eligibilityStatus: "pending", ...input };
      },
    };
    const accounts = new StudentAccounts(store);
    await accounts.upsert({ email: " STUDENT@Example.edu ", phone: "(312) 555-0199", squareCustomerId: "square-1" });
    expect(received).toEqual({ normalizedEmail: "student@example.edu", normalizedPhone: "+13125550199", squareCustomerId: "square-1" });
  });
});
