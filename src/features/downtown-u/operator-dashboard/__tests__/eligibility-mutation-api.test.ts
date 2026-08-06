import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EligibilityMutationRequestError,
  canonicalizeEligibilityReason,
  newEligibilityIdempotencyKey,
  requestSmsReauth,
  submitEligibilityDecision,
  verifySmsReauth,
} from "../eligibility-mutation-api";

const studentId = "123e4567-e89b-42d3-a456-426614174000";
const keyUuid = "223e4567-e89b-42d3-a456-426614174000";
const challengeId = "323e4567-e89b-42d3-a456-426614174000";
const expectedUpdatedAt = "2026-08-06T12:00:00.000Z";
const mutation = {
  studentId,
  expectedStatus: "pending" as const,
  expectedUpdatedAt,
  decision: "approve" as const,
  reasonCode: "documentation_verified" as const,
  reason: "Documents verified 🎓",
};
const result = {
  studentId,
  eligibilityStatus: "approved",
  eligibilityReviewedAt: "2026-08-06T12:01:00.000Z",
  approvedAt: "2026-08-06T12:01:00.000Z",
  updatedAt: "2026-08-06T12:01:00.000Z",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-correlation-id": `operator-mutation:${keyUuid}`, ...headers },
  }));

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("eligibility mutation transport", () => {
  it("creates only canonical opaque in-memory keys and sends the exact mutation request", async () => {
    const fetcher = vi.fn(() => json({ result, replayed: false }));
    vi.stubGlobal("fetch", fetcher);
    const key = newEligibilityIdempotencyKey();
    expect(key).toBe(`opm:v1:${keyUuid}`);
    await expect(submitEligibilityDecision(mutation, key)).resolves.toEqual({ result, replayed: false, correlationId: `operator-mutation:${keyUuid}` });
    expect(fetcher).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe("/api/downtown-u/operator/eligibility-decisions");
    expect(init).toEqual(expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Origin: window.location.origin, "Idempotency-Key": key },
      body: JSON.stringify(mutation), signal: expect.any(AbortSignal),
    }));
    expect(JSON.stringify(init)).not.toMatch(/phone|otp|challenge/i);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(window.location.href).not.toContain(key);
  });

  it("accepts the real server JSON response type with case-insensitive media tokens, but no other representation", async () => {
    for (const contentType of ["application/json; charset=utf-8", "Application/JSON; Charset=UTF-8"]) {
      vi.stubGlobal("fetch", vi.fn(() => json({ result, replayed: false }, 200, { "content-type": contentType })));
      await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).resolves.toMatchObject({ result });
    }
    for (const contentType of ["application/json", "application/json; charset=utf-8; profile=test", "application/jsonx; charset=utf-8", "text/plain"]) {
      vi.stubGlobal("fetch", vi.fn(() => json({ result, replayed: false }, 200, { "content-type": contentType })));
      await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
    }
  });

  it("uses exact empty reauth issuance and exact challenge plus six-digit OTP verification bodies", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => json({ accepted: true, challengeId }, 202))
      .mockImplementationOnce(() => json({ reauthenticated: true, validForSeconds: 300 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestSmsReauth()).resolves.toEqual({ accepted: true, challengeId });
    await expect(verifySmsReauth(challengeId, "012345")).resolves.toEqual({ reauthenticated: true, validForSeconds: 300 });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/downtown-u/operator/auth/reauth/request", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: "{}",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/downtown-u/operator/auth/reauth/verify", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({ challengeId, otp: "012345" }),
    }));
  });

  it.each([
    ["approve", "documentation_verified"],
    ["reject", "documentation_incomplete"],
    ["reject", "policy_ineligible"],
    ["suspend", "safety_hold"],
    ["suspend", "policy_hold"],
    ["reinstate", "hold_cleared"],
  ] as const)("canonicalizes NFC/trimmed scalar-safe notes for %s/%s", (decision, reasonCode) => {
    expect(canonicalizeEligibilityReason(decision, reasonCode, "  Cafe\u0301 🎓  ")).toBe("Café 🎓");
  });

  it("counts Unicode scalars rather than UTF-16 code units at the 500-scalar note boundary", () => {
    expect(canonicalizeEligibilityReason("approve", "documentation_verified", "🎓".repeat(500))).toBe("🎓".repeat(500));
    expect(() => canonicalizeEligibilityReason("approve", "documentation_verified", "🎓".repeat(501))).toThrow();
  });

  it.each([
    "opm:v1:223e4567-e89b-02d3-a456-426614174000",
    "opm:v1:223e4567-e89b-92d3-a456-426614174000",
    "opm:v1:223e4567-e89b-42d3-7456-426614174000",
    "opm:v1:223e4567-e89b-42d3-c456-426614174000",
    "opm:v2:223e4567-e89b-42d3-a456-426614174000",
    "opm:v1:223e4567-e89b-42d3-a456-42661417400-",
  ])("rejects malformed canonical idempotency key %s before transport", async (key) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(submitEligibilityDecision(mutation, key)).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "2026-08-06T12:00:00Z",
    "2026-08-06T12:00:00.000000Z",
    "2026-08-06T12:00:00.000+00:00",
    "2026-08-06T08:00:00.000-04:00",
  ])("rejects noncanonical direct expectedUpdatedAt %s before transport", async (value) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(submitEligibilityDecision({ ...mutation, expectedUpdatedAt: value }, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["approve", { eligibilityStatus: "approved", approvedAt: result.updatedAt }],
    ["reinstate", { eligibilityStatus: "approved", approvedAt: result.updatedAt }],
    ["reject", { eligibilityStatus: "rejected", rejectedAt: result.updatedAt }],
    ["suspend", { eligibilityStatus: "suspended", approvedAt: expectedUpdatedAt, suspendedAt: result.updatedAt }],
  ] as const)("accepts the exact authoritative %s lifecycle result", async (decision, lifecycle) => {
    const reasonCode = decision === "approve" ? "documentation_verified" : decision === "reinstate" ? "hold_cleared" : decision === "reject" ? "documentation_incomplete" : "safety_hold";
    const request = { ...mutation, decision, reasonCode } as Parameters<typeof submitEligibilityDecision>[0];
    const authoritative = { studentId, eligibilityReviewedAt: result.updatedAt, updatedAt: result.updatedAt, ...lifecycle };
    vi.stubGlobal("fetch", vi.fn(() => json({ result: authoritative, replayed: false })));
    await expect(submitEligibilityDecision(request, `opm:v1:${keyUuid}`)).resolves.toMatchObject({ result: authoritative });
  });

  it.each([
    ["pending result", { ...result, eligibilityStatus: "pending" }],
    ["wrong student", { ...result, studentId: challengeId }],
    ["wrong status", { ...result, eligibilityStatus: "rejected", approvedAt: undefined, rejectedAt: result.updatedAt }],
    ["noncanonical timestamp", { ...result, updatedAt: "2026-08-06T12:01:00Z" }],
    ["forbidden lifecycle key", { ...result, rejectedAt: result.updatedAt }],
  ])("fails closed on %s", async (_label, invalid) => {
    const clean = Object.fromEntries(Object.entries(invalid).filter(([, value]) => value !== undefined));
    vi.stubGlobal("fetch", vi.fn(() => json({ result: clean, replayed: false })));
    await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("requires a valid success correlation ID", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Response(JSON.stringify({ result, replayed: false }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    ["approve", "policy_hold", "wrong decision/code pair"],
    ["approve", "documentation_verified", ""],
    ["approve", "documentation_verified", "contains\ncontrol"],
    ["approve", "documentation_verified", "\ud800"],
    ["approve", "documentation_verified", "x".repeat(501)],
  ] as const)("rejects noncanonical reason input %# before transport", (decision, reasonCode, note) => {
    expect(() => canonicalizeEligibilityReason(decision as never, reasonCode as never, note)).toThrow();
  });

  it.each([
    [401, "unauthorized", "session"], [403, "forbidden", "forbidden"], [404, "not_found", "not_found"],
    [409, "stale_state", "conflict"], [409, "conflict", "conflict"], [409, "idempotency_conflict", "conflict"],
    [428, "reauth_required", "reauth"], [429, "rate_limited", "limited"], [503, "unavailable", "unavailable"],
  ] as const)("maps exact eligibility %s/%s to a generic typed %s error", async (status, code, kind) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: code }, status)));
    const failure = submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`).catch((error: unknown) => error);
    await expect(failure).resolves.toEqual(expect.objectContaining({ kind, correlationId: `operator-mutation:${keyUuid}` }));
    const error = await failure as EligibilityMutationRequestError;
    expect(error).toBeInstanceOf(EligibilityMutationRequestError);
    expect(error.message).not.toMatch(/unauthorized|forbidden|not_found|stale_state|idempotency_conflict|reauth_required|rate_limited/);
  });

  it.each([
    [401, { error: "forbidden" }],
    [401, { error: "unauthorized", detail: "extra" }],
    [403, { error: "unauthorized" }],
    [409, { error: "private_detail" }],
    [429, { error: "unavailable" }],
  ])("rejects contradictory or malformed eligibility error JSON for status %s", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn(() => json(body, status)));
    await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("strictly parses reauth errors and keeps conflated wrong-OTP/session verification generic", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ authenticated: false }, 401)));
    await expect(requestSmsReauth()).rejects.toMatchObject({ kind: "session" });
    vi.stubGlobal("fetch", vi.fn(() => json({ reauthenticated: false }, 401)));
    await expect(verifySmsReauth(challengeId, "012345")).rejects.toMatchObject({ kind: "unavailable" });

    for (const invoke of [() => requestSmsReauth(), () => verifySmsReauth(challengeId, "012345")]) {
      vi.stubGlobal("fetch", vi.fn(() => json({ error: "invalid_request" }, 400)));
      await expect(invoke()).rejects.toMatchObject({ kind: "unavailable" });
      vi.stubGlobal("fetch", vi.fn(() => json({ error: "unavailable" }, 503)));
      await expect(invoke()).rejects.toMatchObject({ kind: "unavailable" });
    }
  });

  it.each([
    ["request", 401, { reauthenticated: false }],
    ["request", 401, { authenticated: false, error: "extra" }],
    ["verify", 401, { authenticated: false }],
    ["verify", 503, { error: "invalid_request" }],
  ] as const)("rejects contradictory/malformed %s reauth error JSON", async (endpoint, status, body) => {
    vi.stubGlobal("fetch", vi.fn(() => json(body, status)));
    const operation = endpoint === "request" ? requestSmsReauth() : verifySmsReauth(challengeId, "012345");
    await expect(operation).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("fails closed on oversized, non-JSON, malformed, extra-field, and invalid-correlation responses", async () => {
    const cases = [
      new Response("<html>secret</html>", { status: 200, headers: { "content-type": "text/html" } }),
      new Response("{", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
      new Response(JSON.stringify({ result: { ...result, balance: 900 }, replayed: false }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
      new Response(JSON.stringify({ result, replayed: false }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "content-length": String(65 * 1024) } }),
      new Response(JSON.stringify({ result, replayed: false }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-correlation-id": "private invalid value" } }),
    ];
    for (const response of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(submitEligibilityDecision(mutation, `opm:v1:${keyUuid}`)).rejects.toMatchObject({ kind: "unavailable" });
    }
  });

  it("aborts a stalled mutation and leaves its caller-owned same-intent key reusable", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetcher);
    const key = newEligibilityIdempotencyKey();
    const pending = submitEligibilityDecision(mutation, key);
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout", retryable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    await assertion;
    expect(key).toBe(`opm:v1:${keyUuid}`);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "Idempotency-Key": key });
  });
});
