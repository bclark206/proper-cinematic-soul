import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorRequestError, readOperatorList, readOperatorSession } from "../api";

const studentId = "123e4567-e89b-42d3-a456-426614174000";
const iso = "2026-08-04T12:00:00Z";
const providerEarlier = "2026-08-04T11:59:00Z";
const later = "2026-08-04T13:00:00Z";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } }));
const validItems = {
  students: { id: studentId, eligibilityStatus: "pending", maskedEmail: "p***@e***.test", createdAt: iso, updatedAt: iso },
  purchases: { id: "223e4567-e89b-42d3-a456-426614174000", studentId, planId: "flex-5", creditsGranted: 5, priceCents: 6000, currency: "USD", status: "paid", refundedCredits: 0, paidAt: iso, createdAt: iso, updatedAt: iso },
  redemptions: { id: "323e4567-e89b-42d3-a456-426614174000", studentId, mealName: "Lunch service", credits: 1, status: "redeemed", reservedAt: iso, expiresAt: later, redeemedAt: later, createdAt: iso, updatedAt: later },
  reconciliation: { id: "423e4567-e89b-42d3-a456-426614174000", studentId, category: "payment_follow_up", state: "needs_review", openedAt: iso },
} as const;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("strict operator API client", () => {
  it("sends exact same-origin no-store session and list requests with approved query parameters", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ authenticated: true, operator: { displayName: "Pat", roles: ["eligibility_reviewer"] }, smsReauthFresh: false }))
      .mockImplementationOnce(() => json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    await readOperatorSession();
    await readOperatorList("students", { eligibilityStatus: "pending" }, null);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/downtown-u/operator/auth/session", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal) }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/downtown-u/operator/students?limit=25&eligibilityStatus=pending", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" }));
  });

  it.each([
    { authenticated: true, operator: { displayName: " Pat ", roles: ["eligibility_reviewer"] }, smsReauthFresh: false },
    { authenticated: true, operator: { displayName: "Pat", roles: ["admin"] }, smsReauthFresh: false },
    { authenticated: true, operator: { displayName: "Pat", roles: ["audit_exporter", "audit_exporter"] }, smsReauthFresh: false },
    { authenticated: true, operator: { displayName: "Pat", roles: ["eligibility_reviewer"] }, smsReauthFresh: false, extra: true },
  ])("rejects malformed session %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(() => json(body)));
    await expect(readOperatorSession()).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("strictly validates exact list schemas and rejects extra/trap fields", async () => {
    const valid = validItems.students;
    for (const item of [{ ...valid, email: "private@example.test" }, { ...valid, status: "approved" }, { ...valid, id: "bad" }]) {
      vi.stubGlobal("fetch", vi.fn(() => json({ items: [item], nextCursor: null })));
      await expect(readOperatorList("students", {}, null)).rejects.toMatchObject({ kind: "unavailable" });
    }
  });

  it("accepts a canonical paid purchase when its provider paid timestamp precedes persistence", async () => {
    const purchase = { ...validItems.purchases, paidAt: providerEarlier };
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [purchase], nextCursor: null })));
    await expect(readOperatorList("purchases", {}, null)).resolves.toMatchObject({ items: [purchase] });
  });

  it.each([
    ["approved without approvedAt", { id: studentId, eligibilityStatus: "approved", maskedEmail: "p***@e***.test", createdAt: iso, updatedAt: iso }],
    ["rejected without rejectedAt", { id: studentId, eligibilityStatus: "rejected", maskedEmail: "p***@e***.test", createdAt: iso, updatedAt: iso }],
    ["suspended without suspendedAt and with approvedAt", { id: studentId, eligibilityStatus: "suspended", maskedEmail: "p***@e***.test", approvedAt: iso, createdAt: iso, updatedAt: iso }],
    ["pending with an earlier eligibilityReviewedAt", { id: studentId, eligibilityStatus: "pending", maskedEmail: "p***@e***.test", eligibilityReviewedAt: providerEarlier, createdAt: iso, updatedAt: iso }],
    ["approved with an earlier approvedAt", { id: studentId, eligibilityStatus: "approved", maskedEmail: "p***@e***.test", approvedAt: providerEarlier, createdAt: iso, updatedAt: iso }],
    ["updated before created", { id: studentId, eligibilityStatus: "pending", maskedEmail: "p***@e***.test", createdAt: iso, updatedAt: providerEarlier }],
    ["deleted before created", { id: studentId, eligibilityStatus: "pending", maskedEmail: "p***@e***.test", deletedAt: providerEarlier, createdAt: iso, updatedAt: iso }],
    ["maximum E.164 phone mask", { id: studentId, eligibilityStatus: "pending", maskedPhone: "+***********1234", createdAt: iso, updatedAt: iso }],
  ] as const)("accepts a schema-valid student: %s", async (_label, student) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [student], nextCursor: null })));
    await expect(readOperatorList("students", {}, null)).resolves.toMatchObject({ items: [student] });
  });

  it.each([
    ["pending", "approvedAt"], ["pending", "rejectedAt"], ["pending", "suspendedAt"],
    ["approved", "rejectedAt"], ["approved", "suspendedAt"],
    ["rejected", "approvedAt"], ["rejected", "suspendedAt"],
    ["suspended", "rejectedAt"],
  ] as const)("rejects %s students carrying %s", async (eligibilityStatus, conflictingTimestamp) => {
    const student = { id: studentId, eligibilityStatus, maskedEmail: "p***@e***.test", [conflictingTimestamp]: iso, createdAt: iso, updatedAt: iso };
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [student], nextCursor: null })));
    await expect(readOperatorList("students", {}, null)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    ["pending", "eligibilityReviewedAt"], ["approved", "approvedAt"], ["rejected", "rejectedAt"],
    ["suspended", "suspendedAt"], ["pending", "deletedAt"],
  ] as const)("requires an ISO value for optional student timestamp %s", async (eligibilityStatus, timestampKey) => {
    const student = { id: studentId, eligibilityStatus, maskedEmail: "p***@e***.test", [timestampKey]: "not-a-timestamp", createdAt: iso, updatedAt: iso };
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [student], nextCursor: null })));
    await expect(readOperatorList("students", {}, null)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    { id: "323e4567-e89b-42d3-a456-426614174000", studentId, mealName: "Lunch service", credits: 1, status: "reserved", reservedAt: iso, createdAt: iso, updatedAt: iso },
    { id: "323e4567-e89b-42d3-a456-426614174000", studentId, mealName: "Lunch service", credits: 1, status: "redeemed", reservedAt: iso, redeemedAt: later, createdAt: iso, updatedAt: later },
  ])("accepts a valid $status redemption when nullable expiry is omitted", async (redemption) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [redemption], nextCursor: null })));
    await expect(readOperatorList("redemptions", {}, null)).resolves.toMatchObject({ items: [redemption] });
  });

  it.each([
    ["students", { id: studentId, eligibilityStatus: "pending", createdAt: iso, updatedAt: iso }],
    ["purchases", { ...validItems.purchases, priceCents: 2500 }],
    ["redemptions", { ...validItems.redemptions, status: "reserved" }],
    ["reconciliation", { ...validItems.reconciliation, state: "resolved" }],
  ] as const)("rejects lifecycle/economic inconsistency for %s", async (endpoint, item) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [item], nextCursor: null })));
    await expect(readOperatorList(endpoint, {}, null)).rejects.toEqual(expect.objectContaining({ kind: "unavailable", message: "unavailable" }));
  });

  it("rejects duplicate IDs and does not leak malformed item data", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [validItems.students, validItems.students], nextCursor: null })));
    await expect(readOperatorList("students", {}, null)).rejects.toEqual(expect.objectContaining({ kind: "unavailable", message: "unavailable" }));
  });

  it.each(["accessor", "symbol", "proxy"])("rejects hostile %s response structures generically", async (kind) => {
    const item: Record<PropertyKey, unknown> = { ...validItems.students };
    let hostile: unknown = item;
    if (kind === "accessor") Object.defineProperty(item, "maskedEmail", { get: () => { throw new Error("private getter"); }, enumerable: true });
    if (kind === "symbol") item[Symbol("private symbol")] = "secret";
    if (kind === "proxy") hostile = new Proxy(item, { ownKeys: () => { throw new Error("private proxy trap"); } });
    vi.stubGlobal("fetch", vi.fn(() => json({ ignored: true })));
    vi.spyOn(JSON, "parse").mockReturnValueOnce({ items: [hostile], nextCursor: null });
    await expect(readOperatorList("students", {}, null)).rejects.toEqual(expect.objectContaining({ kind: "unavailable", message: "unavailable" }));
  });

  it("returns detached frozen data rather than retaining parsed response references", async () => {
    const source = { items: [{ ...validItems.students }], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn(() => json({ ignored: true })));
    vi.spyOn(JSON, "parse").mockReturnValueOnce(source);
    const result = await readOperatorList("students", {}, null);
    expect(result).not.toBe(source);
    expect(result.items).not.toBe(source.items);
    expect(result.items[0]).not.toBe(source.items[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    source.items[0].eligibilityStatus = "approved";
    expect(result.items[0].eligibilityStatus).toBe("pending");
  });

  it.each([
    ["students", { unknown: "pending" }, null],
    ["students", { eligibilityStatus: "PENDING" }, null],
    ["purchases", { studentId: studentId.toUpperCase() }, null],
    ["redemptions", { status: "paid" }, null],
    ["reconciliation", { category: "other" }, null],
    ["students", {}, "not.a.valid.cursor"],
  ] as const)("rejects invalid local %s filters/cursor before fetch", async (endpoint, filters, cursor) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readOperatorList(endpoint, filters, cursor)).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("encodes each endpoint's exact approved filters and an exact cursor", async () => {
    const fetcher = vi.fn(() => json({ items: [], nextCursor: null })); vi.stubGlobal("fetch", fetcher);
    await readOperatorList("purchases", { status: "partially_refunded", studentId }, "opaque.sig");
    await readOperatorList("redemptions", { status: "cancelled", studentId }, null);
    await readOperatorList("reconciliation", { state: "resolved", category: "kitchen_follow_up", studentId }, null);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `/api/downtown-u/operator/purchases?limit=25&status=partially_refunded&studentId=${studentId}&cursor=opaque.sig`,
      `/api/downtown-u/operator/redemptions?limit=25&status=cancelled&studentId=${studentId}`,
      `/api/downtown-u/operator/reconciliation?limit=25&state=resolved&category=kitchen_follow_up&studentId=${studentId}`,
    ]);
  });

  it.each([[401, "session"], [403, "forbidden"], [503, "unavailable"]] as const)("maps HTTP %s to typed generic %s", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "raw private detail", requestId: "secret" }, status)));
    await expect(readOperatorList("students", {}, null)).rejects.toEqual(expect.objectContaining({ kind }));
  });

  it("rejects oversized bodies before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [], nextCursor: null }, 200, { "content-length": String(257 * 1024) })));
    await expect(readOperatorList("students", {}, null)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("aborts a stalled list request at ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))));
    const request = readOperatorList("students", {}, null);
    const assertion = expect(request).rejects.toBeInstanceOf(OperatorRequestError);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    await assertion;
  });
});
