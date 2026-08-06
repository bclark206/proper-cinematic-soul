import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  OPERATOR_ELIGIBILITY_MAX_BODY_BYTES,
  OperatorEligibilityBoundaryError,
  parseOperatorEligibilityMutationRequest,
} from "../eligibility-http";
import { validateEligibilityMutationItem } from "../eligibility-types";

const origin = "https://operator.example.test";
const studentId = "223e4567-e89b-42d3-a456-426614174000";
const idempotencyKey = "opm:v1:323e4567-e89b-42d3-a456-426614174000";
const expectedUpdatedAt = "2026-08-06T12:00:00.000Z";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const bearer = "A".repeat(43);
const cookie = `__Host-downtown_u_operator_session=v1.${sessionId}.${bearer}`;
const endpoint = "/api/downtown-u/operator/eligibility-decisions";

const validBody = Object.freeze({
  studentId,
  expectedStatus: "pending",
  expectedUpdatedAt,
  decision: "approve",
  reasonCode: "documentation_verified",
  reason: "Documents verified",
});

function rawRequest(
  raw: Uint8Array | string = JSON.stringify(validBody),
  overrides: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    cookie,
  };
  const rawHeaders = Object.entries(headers).flat();
  return Object.assign(Readable.from([raw]), {
    method: "POST",
    url: endpoint,
    headers,
    rawHeaders,
    ...overrides,
  });
}

async function reject(raw: Uint8Array | string, overrides: Record<string, unknown> = {}) {
  await expect(parseOperatorEligibilityMutationRequest(rawRequest(raw, overrides), origin))
    .rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
}

describe("eligibility mutation HTTP boundary", () => {
  it("accepts only the exact canonical request and returns copied trusted values", async () => {
    const parsed = await parseOperatorEligibilityMutationRequest(rawRequest(), origin);
    expect(parsed).toEqual({
      body: validBody,
      credential: { sessionId, bearer },
      idempotencyKey,
    });
    expect(parsed.body).not.toBe(validBody);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.body)).toBe(true);
    expect(OPERATOR_ELIGIBILITY_MAX_BODY_BYTES).toBe(8 * 1024);
  });

  it.each([
    ["approve", "pending", "documentation_verified"],
    ["reject", "pending", "documentation_incomplete"],
    ["reject", "pending", "policy_ineligible"],
    ["suspend", "approved", "safety_hold"],
    ["suspend", "approved", "policy_hold"],
    ["reinstate", "suspended", "hold_cleared"],
  ])("accepts transition %s from %s for %s", async (decision, expectedStatus, reasonCode) => {
    const body = { ...validBody, decision, expectedStatus, reasonCode };
    await expect(parseOperatorEligibilityMutationRequest(rawRequest(JSON.stringify(body)), origin))
      .resolves.toMatchObject({ body });
  });

  it.each([
    ["approve", "approved", "documentation_verified"],
    ["approve", "pending", "documentation_incomplete"],
    ["reject", "approved", "policy_ineligible"],
    ["reject", "pending", "safety_hold"],
    ["suspend", "pending", "safety_hold"],
    ["suspend", "approved", "hold_cleared"],
    ["reinstate", "approved", "hold_cleared"],
    ["reinstate", "suspended", "policy_hold"],
  ])("rejects invalid transition tuple %s/%s/%s", async (decision, expectedStatus, reasonCode) => {
    await reject(JSON.stringify({ ...validBody, decision, expectedStatus, reasonCode }));
  });

  it.each([
    { studentId: studentId.toUpperCase() },
    { studentId: "not-a-uuid" },
    { expectedUpdatedAt: "2026-08-06T12:00:00Z" },
    { expectedUpdatedAt: "2026-02-30T00:00:00.000Z" },
    { expectedUpdatedAt: "2026-08-06t12:00:00.000z" },
    { reason: " Documents verified" },
    { reason: "Documents verified " },
    { reason: "" },
    { reason: "x".repeat(501) },
    { reason: "e\u0301" },
    { reason: "line\nfeed" },
    { reason: "c0\u0000" },
    { reason: "c1\u0085" },
    { reason: 7 },
  ])("rejects noncanonical field %#", async (change) => reject(JSON.stringify({ ...validBody, ...change })));

  it("counts Unicode scalars rather than UTF-16 code units", async () => {
    const accepted = { ...validBody, reason: "😀".repeat(500) };
    await expect(parseOperatorEligibilityMutationRequest(rawRequest(JSON.stringify(accepted)), origin))
      .resolves.toMatchObject({ body: accepted });
    await reject(JSON.stringify({ ...accepted, reason: `${accepted.reason}😀` }));
  });

  it.each([
    `{"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"\\ud800"}`,
    `{"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"\\udc00"}`,
    `{"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"\\ud800x"}`,
    `{"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"\\ud800\\ud800"}`,
  ])("rejects malformed Unicode scalar strings after JSON unescaping", async (raw) => reject(raw));

  it.each([
    "{}",
    "[]",
    "null",
    JSON.stringify({ ...validBody, extra: true }),
    JSON.stringify(Object.fromEntries(Object.entries(validBody).filter(([key]) => key !== "reason"))),
    `{"studentId":"${studentId}","studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"ok"}`,
    `{"__proto__":{},"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"ok"}`,
    `{"constructor":{},"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"ok"}`,
    `{"prototype":{},"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"ok"}`,
    "{",
    `${JSON.stringify(validBody)} trailing`,
  ])("rejects strict JSON ambiguity %#", async (raw) => reject(raw));

  it("rejects empty, fatal UTF-8 and over-8KiB bodies, terminating an oversized iterator", async () => {
    await reject("");
    await reject(Buffer.from([0xff]));
    await reject("x".repeat(8 * 1024 + 1));
    let returned = false;
    const iterator = {
      index: 0,
      async next() { this.index += 1; return this.index === 1 ? { done: false, value: Buffer.alloc(8 * 1024 + 1) } : { done: true, value: undefined }; },
      async return() { returned = true; return { done: true, value: undefined }; },
    };
    const request = rawRequest("{}", { [Symbol.asyncIterator]: () => iterator });
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
    expect(returned).toBe(true);
  });

  it.each([
    ["origin", "https://evil.test"],
    ["origin", "https://operator.example.test/"],
    ["sec-fetch-site", "cross-site"],
  ])("forbids foreign %s", async (name, value) => {
    const request = rawRequest();
    request.headers[name] = value;
    request.rawHeaders = Object.entries(request.headers).flat();
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    ["content-type", "application/json; charset=utf-8"],
    ["content-type", "Application/JSON"],
    ["transfer-encoding", "chunked"],
    ["content-length", "01"],
    ["content-length", "+1"],
    ["content-length", "8193"],
  ])("rejects noncanonical framing %s=%s", async (name, value) => {
    const request = rawRequest();
    request.headers[name] = value;
    request.rawHeaders = Object.entries(request.headers).flat();
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
  });

  it("accepts only an exact matching canonical content-length", async () => {
    const raw = JSON.stringify(validBody);
    const request = rawRequest(raw);
    request.headers["content-length"] = String(Buffer.byteLength(raw));
    request.rawHeaders = Object.entries(request.headers).flat();
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).resolves.toBeDefined();
    for (const declared of ["0", String(Buffer.byteLength(raw) + 1)]) {
      const mismatch = rawRequest(raw);
      mismatch.headers["content-length"] = declared;
      mismatch.rawHeaders = Object.entries(mismatch.headers).flat();
      await expect(parseOperatorEligibilityMutationRequest(mismatch, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
    }
  });

  it.each([
    "opm:v1:323E4567-e89b-42d3-a456-426614174000",
    "opm:v2:323e4567-e89b-42d3-a456-426614174000",
    "323e4567-e89b-42d3-a456-426614174000",
    "opm:v1:not-a-uuid",
    " opm:v1:323e4567-e89b-42d3-a456-426614174000",
    "opm:v1:323e4567-e89b-42d3-a456-426614174000,other",
  ])("rejects noncanonical idempotency key %j", async (value) => {
    const request = rawRequest();
    request.headers["idempotency-key"] = value;
    request.rawHeaders = Object.entries(request.headers).flat();
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
  });

  it("requires Origin, Content-Type, Idempotency-Key, and exactly one host credential", async () => {
    for (const key of ["origin", "content-type", "idempotency-key", "cookie"]) {
      const request = rawRequest();
      delete request.headers[key];
      request.rawHeaders = Object.entries(request.headers).flat();
      await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
    }
    for (const badCookie of [cookie + "; " + cookie, "other=x", `${cookie}; bearer=${bearer}`]) {
      const request = rawRequest(); request.headers.cookie = badCookie; request.rawHeaders = Object.entries(request.headers).flat();
      await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
    }
  });

  it("rejects duplicate or disagreeing raw headers, including differently cased names", async () => {
    for (const pair of [["Origin", origin], ["Content-Type", "application/json"], ["Idempotency-Key", idempotencyKey], ["Cookie", cookie]]) {
      const request = rawRequest(); request.rawHeaders.push(...pair);
      await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
    }
    const disagree = rawRequest(); disagree.rawHeaders = disagree.rawHeaders.map((value, index) => index === 1 ? "https://evil.test" : value);
    await expect(parseOperatorEligibilityMutationRequest(disagree, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
  });

  it.each([
    `${endpoint}?x=1`, `${endpoint}?studentId=${studentId}`, `${endpoint}?idempotencyKey=${idempotencyKey}`,
    `${endpoint}?correlationId=client`, `${endpoint}#x`, "/api/downtown-u/operator/eligibility-decisions/",
    "https://operator.example.test/api/downtown-u/operator/eligibility-decisions",
  ])("rejects unknown or duplicated URL input %j", async (url) => {
    await expect(parseOperatorEligibilityMutationRequest(rawRequest(undefined as never, { url }), origin))
      .rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
  });

  it("rejects body/query bearer, idempotency and correlation duplication", async () => {
    for (const extra of [{ bearer }, { cookie }, { idempotencyKey }, { correlationId: "client" }]) {
      await reject(JSON.stringify({ ...validBody, ...extra }));
    }
  });

  it("does not invoke accessors or proxy traps in request metadata", async () => {
    for (const key of ["method", "url", "headers", "rawHeaders", "body"]) {
      const getter = vi.fn(() => key === "method" ? "POST" : undefined);
      const request = rawRequest();
      Object.defineProperty(request, key, { configurable: true, enumerable: true, get: getter });
      await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
      expect(getter).not.toHaveBeenCalled();
    }
    const request = rawRequest();
    request.headers = new Proxy({}, { ownKeys() { throw new TypeError("trap"); } }) as never;
    await expect(parseOperatorEligibilityMutationRequest(request, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
  });

  it("rejects request, headers, and rawHeaders proxies before every reflection trap", async () => {
    for (const boundary of ["request", "headers", "rawHeaders"] as const) {
      const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
      const hostile = new Proxy(boundary === "rawHeaders" ? [] : {}, {
        get() { counts.get++; throw new Error("get trap"); },
        getPrototypeOf() { counts.getPrototypeOf++; throw new Error("prototype trap"); },
        ownKeys() { counts.ownKeys++; throw new Error("keys trap"); },
        getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor++; throw new Error("descriptor trap"); },
      });
      const candidate: Record<PropertyKey, unknown> = boundary === "request" ? hostile : rawRequest();
      if (boundary !== "request") candidate[boundary] = hostile;
      await expect(parseOperatorEligibilityMutationRequest(candidate, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
      expect(counts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    }
  });

  it("rejects iterator and chunk proxies without invoking their traps", async () => {
    for (const boundary of ["iterator", "chunk"] as const) {
      const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
      const hostile = new Proxy(boundary === "chunk" ? Buffer.from("{}") : {}, {
        get() { counts.get++; throw new Error("get trap"); },
        getPrototypeOf() { counts.getPrototypeOf++; throw new Error("prototype trap"); },
        ownKeys() { counts.ownKeys++; throw new Error("keys trap"); },
        getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor++; throw new Error("descriptor trap"); },
      });
      const iterator = boundary === "iterator" ? hostile : {
        step: 0,
        async next() { this.step += 1; return this.step === 1 ? { done: false as const, value: hostile } : { done: true as const, value: undefined }; },
      };
      const candidate = rawRequest("{}", { [Symbol.asyncIterator]: () => iterator });
      await expect(parseOperatorEligibilityMutationRequest(candidate, origin)).rejects.toBeInstanceOf(OperatorEligibilityBoundaryError);
      expect(counts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    }
  });

  it("accepts native Buffer/Uint8Array chunks, detaches before next, and never reflects over a custom chunk prototype", async () => {
    const raw = Buffer.from(JSON.stringify(validBody));
    const split = Math.floor(raw.length / 2);
    const first = Buffer.from(raw.subarray(0, split));
    const second = Uint8Array.from(raw.subarray(split));
    let step = 0;
    const iterator = {
      async next() {
        step += 1;
        if (step === 1) return { done: false as const, value: first };
        if (step === 2) { first.fill(0x78); return { done: false as const, value: second }; }
        return { done: true as const, value: undefined };
      },
    };
    const candidate = rawRequest("{}", { [Symbol.asyncIterator]: () => iterator });
    await expect(parseOperatorEligibilityMutationRequest(candidate, origin)).resolves.toMatchObject({ body: validBody });

    const custom = Uint8Array.from(raw);
    const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
    const hostilePrototype = new Proxy({}, {
      get() { counts.get++; throw new Error("get trap"); },
      getPrototypeOf() { counts.getPrototypeOf++; throw new Error("prototype trap"); },
      ownKeys() { counts.ownKeys++; throw new Error("keys trap"); },
      getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor++; throw new Error("descriptor trap"); },
    });
    Object.setPrototypeOf(custom, hostilePrototype);
    const customCandidate = rawRequest("{}", { [Symbol.asyncIterator]: () => ({
      step: 0,
      async next() {
        this.step += 1;
        return this.step === 1 ? { done: false as const, value: custom } : { done: true as const, value: undefined };
      },
    }) });
    await expect(parseOperatorEligibilityMutationRequest(customCandidate, origin)).resolves.toMatchObject({ body: validBody });
    expect(counts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
  });
});

const validItem = Object.freeze({
  studentId,
  eligibilityStatus: "approved",
  eligibilityReviewedAt: expectedUpdatedAt,
  approvedAt: expectedUpdatedAt,
  updatedAt: expectedUpdatedAt,
});

describe("eligibility mutation public item validator", () => {
  it("copies and freezes the exact redacted item", () => {
    const output = validateEligibilityMutationItem(validItem);
    expect(output).toEqual(validItem);
    expect(output).not.toBe(validItem);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.keys(output)).toEqual(["studentId", "eligibilityStatus", "eligibilityReviewedAt", "approvedAt", "updatedAt"]);
  });

  it.each([
    { ...validItem, email: "secret@example.test" },
    { ...validItem, phone: "+14155550123" },
    { ...validItem, reason: "secret" },
    { ...validItem, auditId: studentId },
    { ...validItem, operatorId: studentId },
    { ...validItem, sessionId },
    { ...validItem, raw: Buffer.from("secret") },
    { ...validItem, studentId: studentId.toUpperCase() },
    { ...validItem, updatedAt: "2026-08-06T12:00:00Z" },
    { ...validItem, eligibilityStatus: "pending" },
    { ...validItem, rejectedAt: expectedUpdatedAt },
    { studentId, eligibilityStatus: "suspended", eligibilityReviewedAt: expectedUpdatedAt, suspendedAt: expectedUpdatedAt, updatedAt: expectedUpdatedAt },
  ])("rejects forbidden/malformed output %#", (item) => expect(() => validateEligibilityMutationItem(item)).toThrow());

  it("rejects accessors, symbols, prototypes, and proxies without invoking getters", () => {
    const accessor = { ...validItem }; const getter = vi.fn(() => studentId);
    Object.defineProperty(accessor, "studentId", { enumerable: true, get: getter });
    const symbol = { ...validItem, [Symbol("secret")]: true };
    const prototype = Object.assign(Object.create({ inherited: true }), validItem);
    const proxy = new Proxy({}, { getPrototypeOf() { throw new TypeError("trap"); } });
    for (const item of [accessor, symbol, prototype, proxy]) expect(() => validateEligibilityMutationItem(item)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
