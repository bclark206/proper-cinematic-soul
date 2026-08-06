import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOperatorAuthCryptography } from "../../../../server/downtown-u/operator/auth-crypto";
import { createReadCursorCodec, OperatorReadCursorError } from "../../../../server/downtown-u/operator/read-cursor";
import type { OperatorReadEndpoint, ReadFilters } from "../../../../server/downtown-u/operator/read-types";
import {
  createOperatorReadHandler,
  createProductionOperatorReadHandler,
  type NodeOperatorReadRequest,
  type NodeOperatorReadResponse,
} from "../read-handler";

const origin = "https://operator.example.test";
const session = "123e4567-e89b-42d3-a456-426614174000";
const studentId = "223e4567-e89b-42d3-a456-426614174000";
const itemId = "323e4567-e89b-42d3-a456-426614174000";
const bearer = "A".repeat(43);
const secret = "AyQ7Gu1FZ6fR1esxrvIGvIN8Yl-Bhb12oZSjgqU2xLY";
const cookie = `__Host-downtown_u_operator_session=v1.${session}.${bearer}`;
const at = "2026-08-06T12:00:00.000Z";
const crypto = createOperatorAuthCryptography(secret);

function request(
  endpoint: OperatorReadEndpoint = "students",
  additions: Partial<NodeOperatorReadRequest> = {},
): NodeOperatorReadRequest {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: `/api/downtown-u/operator/${endpoint}`,
    headers: { cookie },
  }, additions);
}
function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const value: NodeOperatorReadResponse = {
    setHeader(name, headerValue) { result.headers[name] = headerValue; },
    status(status) { return { json(body) { result.status = status; result.body = body; } }; },
  };
  return { result, response: value };
}
function fixture(endpoint: OperatorReadEndpoint) {
  if (endpoint === "students") return { id: itemId, eligibilityStatus: "approved", maskedEmail: "a***@e***.edu", maskedPhone: "+***********2345", createdAt: at, updatedAt: at };
  if (endpoint === "purchases") return { id: itemId, studentId, planId: "flex-5", creditsGranted: 5, priceCents: 6000, currency: "USD", status: "paid", refundedCredits: 0, paidAt: at, createdAt: at, updatedAt: at };
  if (endpoint === "redemptions") return { id: itemId, studentId, mealName: "Redacted meal", credits: 1, status: "reserved", reservedAt: at, createdAt: at, updatedAt: at };
  return { id: itemId, studentId, category: "payment_follow_up", state: "needs_review", openedAt: at };
}
function nullFilters(endpoint: OperatorReadEndpoint): ReadFilters {
  if (endpoint === "students") return { eligibilityStatus: null, studentId: null };
  if (endpoint === "purchases") return { status: null, studentId: null, purchaseId: null };
  if (endpoint === "redemptions") return { status: null, studentId: null, redemptionId: null };
  return { state: null, category: null, studentId: null, caseId: null };
}
function setup(endpoint: OperatorReadEndpoint = "students", outcome: unknown = { outcome: "authorized", items: [] }) {
  const read = vi.fn().mockResolvedValue(outcome);
  const compose = vi.fn(() => ({ store: { read }, cryptography: crypto }));
  return { read, compose, handler: createOperatorReadHandler(endpoint, origin, compose) };
}

const securityHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

describe("operator dashboard GET boundary hardening", () => {
  it("returns exact 405, Allow GET and security headers without composition", async () => {
    const setupValue = setup(); const output = response();
    await setupValue.handler(request("students", { method: "POST" }), output.response);
    expect(output.result).toEqual({ status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "GET", "Content-Type": "application/json; charset=utf-8", ...securityHeaders } });
    expect(setupValue.compose).not.toHaveBeenCalled(); expect(setupValue.read).not.toHaveBeenCalled();
  });
  it.each([
    { headers: { cookie, "content-type": "application/json" } },
    { headers: { cookie, "content-length": "0" } },
    { headers: { cookie, "transfer-encoding": "chunked" } },
    { headers: { Cookie: cookie, cookie } },
    { headers: { cookie }, rawHeaders: ["cookie", cookie, "Cookie", cookie] },
    { headers: { cookie }, body: {} },
  ])("maps malformed/entity/duplicate boundary to 400 without composition %#", async (change) => {
    const setupValue = setup(); const output = response();
    await setupValue.handler(request("students", change), output.response);
    expect(output.result).toMatchObject({ status: 400, body: { error: "invalid_request" }, headers: securityHeaders });
    expect(setupValue.compose).not.toHaveBeenCalled(); expect(setupValue.read).not.toHaveBeenCalled();
  });
  it.each([
    { headers: { cookie, origin: "https://foreign.test" } },
    { headers: { cookie, "sec-fetch-site": "cross-site" } },
    { headers: { cookie, origin }, rawHeaders: ["cookie", cookie, "origin", "https://foreign.test"] },
  ])("maps semantically foreign metadata to 403 without composition %#", async (change) => {
    const setupValue = setup(); const output = response();
    await setupValue.handler(request("students", change), output.response);
    expect(output.result).toMatchObject({ status: 403, body: { error: "forbidden" }, headers: securityHeaders });
    expect(setupValue.compose).not.toHaveBeenCalled(); expect(setupValue.read).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { cookie: "bad" },
    { cookie: `${cookie}; __Host-downtown_u_operator_session=v1.${session}.${bearer}` },
  ])("maps missing/malformed/duplicate cookie to 401 without composition %#", async (headers) => {
    const setupValue = setup(); const output = response();
    await setupValue.handler(request("students", { headers }), output.response);
    expect(output.result).toMatchObject({ status: 401, body: { error: "unauthorized" }, headers: securityHeaders });
    expect(setupValue.compose).not.toHaveBeenCalled(); expect(setupValue.read).not.toHaveBeenCalled();
  });
  it("does not compose or call the store on malformed path/query", async () => {
    for (const url of ["/api/downtown-u/operator/purchases", "/api/downtown-u/operator/students?limit=01"]) {
      const setupValue = setup(); const output = response(); await setupValue.handler(request("students", { url }), output.response);
      expect(output.result.status).toBe(400); expect(setupValue.compose).not.toHaveBeenCalled(); expect(setupValue.read).not.toHaveBeenCalled();
    }
  });
});

describe("operator dashboard handler outcomes", () => {
  it.each([
    ["students", `eligibilityStatus=approved&studentId=${studentId}`, { eligibilityStatus: "approved", studentId }],
    ["purchases", `status=paid&studentId=${studentId}&purchaseId=${itemId}`, { status: "paid", studentId, purchaseId: itemId }],
    ["redemptions", `status=reserved&studentId=${studentId}&redemptionId=${itemId}`, { status: "reserved", studentId, redemptionId: itemId }],
    ["reconciliation", `state=needs_review&category=payment_follow_up&studentId=${studentId}&caseId=${itemId}`,
      { state: "needs_review", category: "payment_follow_up", studentId, caseId: itemId }],
  ] as const)("passes exact normalized %s filters, digest, and correlation to the store", async (endpoint, query, filters) => {
    const setupValue = setup(endpoint); const output = response();
    await setupValue.handler(request(endpoint, { url: `/api/downtown-u/operator/${endpoint}?limit=7&${query}` }), output.response);
    expect(setupValue.read).toHaveBeenCalledOnce();
    expect(setupValue.read).toHaveBeenCalledWith({
      endpoint,
      sessionId: session,
      sessionDigest: crypto.digestSession(session, bearer),
      correlationId: expect.stringMatching(/^operator-dashboard:[0-9a-f-]{36}$/),
      requestedLimit: 8,
      cursor: null,
      filters,
    });
  });

  it.each(["students", "purchases", "redemptions", "reconciliation"] as const)("returns exact redacted %s payload and timestamps its next cursor", async (endpoint) => {
    const first = fixture(endpoint); const extra = { ...fixture(endpoint), id: "423e4567-e89b-42d3-a456-426614174000" };
    const setupValue = setup(endpoint, { outcome: "authorized", items: [first, extra] }); const output = response();
    await setupValue.handler(request(endpoint, { url: `/api/downtown-u/operator/${endpoint}?limit=1` }), output.response);
    expect(output.result.status).toBe(200);
    const body = output.result.body as { items: unknown[]; nextCursor: string };
    expect(body).toEqual({ items: [first], nextCursor: expect.any(String) });
    expect(Object.keys(body)).toEqual(["items", "nextCursor"]); expect(JSON.stringify(body)).not.toContain("total");
    expect(createReadCursorCodec(crypto).decode(body.nextCursor, endpoint, nullFilters(endpoint), session)).toEqual({ createdAt: at, id: itemId });
    expect(setupValue.read).toHaveBeenCalledOnce();
    expect(setupValue.read).toHaveBeenCalledWith(expect.objectContaining({ endpoint, requestedLimit: 2, cursor: null, filters: nullFilters(endpoint), correlationId: expect.stringMatching(/^operator-dashboard:[0-9a-f-]{36}$/) }));
  });
  it("returns empty exact payload with null cursor and calls store once", async () => {
    const setupValue = setup(); const output = response(); await setupValue.handler(request(), output.response);
    expect(output.result).toMatchObject({ status: 200, body: { items: [], nextCursor: null } }); expect(setupValue.read).toHaveBeenCalledOnce();
  });
  it("rejects more than requested limit+1", async () => {
    const setupValue = setup("students", { outcome: "authorized", items: Array.from({ length: 4 }, (_, index) => ({ ...fixture("students"), id: `${index + 1}23e4567-e89b-42d3-a456-426614174000` })) });
    const output = response(); await setupValue.handler(request("students", { url: "/api/downtown-u/operator/students?limit=2" }), output.response);
    expect(output.result).toMatchObject({ status: 503, body: { error: "unavailable" } });
  });
  it.each([
    ["forbidden raw field", { ...fixture("students"), normalizedEmail: "raw-secret@example.test" }],
    ["accessor", Object.defineProperty({ ...fixture("students") }, "maskedEmail", { enumerable: true, get: () => "raw-secret@example.test" })],
    ["symbol", Object.assign({ ...fixture("students") }, { [Symbol("raw-secret")]: "raw-secret@example.test" })],
    ["buffer", Buffer.from("raw-secret@example.test")],
    ["proxy", new Proxy({ ...fixture("students") }, { ownKeys() { throw new Error("raw-secret@example.test"); } })],
  ])("rejects a %s response trap without serializing or logging it", async (_name, trappedItem) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const setupValue = setup("students", { outcome: "authorized", items: [trappedItem] });
      const output = response(); await setupValue.handler(request(), output.response);
      expect(output.result).toMatchObject({ status: 503, body: { error: "unavailable" } });
      expect(JSON.stringify(output.result)).not.toContain("raw-secret");
      expect(errorLog).not.toHaveBeenCalled(); expect(warnLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); warnLog.mockRestore(); }
  });
  it("maps only cursor decoding failures to 400; TypeError/store/result/crypto failures remain 503 with a valid cursor", async () => {
    const filters = nullFilters("students"); const cursor = createReadCursorCodec(crypto).encode("students", filters, session, at, itemId);
    const url = `/api/downtown-u/operator/students?cursor=${cursor}`;
    const malformed = setup("students", { outcome: "authorized", items: [{ ...fixture("students"), extra: true }] });
    const malformedOutput = response(); await malformed.handler(request("students", { url }), malformedOutput.response);
    expect(malformedOutput.result.status).toBe(503);
    const throwing = setup(); throwing.read.mockRejectedValue(new TypeError("internal")); const throwingOutput = response();
    await throwing.handler(request("students", { url }), throwingOutput.response); expect(throwingOutput.result.status).toBe(503);
    const misleading = setup(); misleading.read.mockRejectedValue(new OperatorReadCursorError()); const misleadingOutput = response();
    await misleading.handler(request("students", { url }), misleadingOutput.response); expect(misleadingOutput.result.status).toBe(503);
    const badCursor = response(); await setup().handler(request("students", { url: "/api/downtown-u/operator/students?cursor=a.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), badCursor.response);
    expect(badCursor.result.status).toBe(400);
  });
});

describe("production operator read composition is lazy and fail closed", () => {
  const databaseUrl = "postgres://operator:secret@db.example.test/operator?sslmode=verify-full&channel_binding=require";
  const validEnv = { DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin, DOWNTOWN_U_OPERATOR_ENABLED: "1", DOWNTOWN_U_OPERATOR_AUTH_SECRET: secret, DOWNTOWN_U_AUTH_SECRET: "different", DOWNTOWN_U_OPERATOR_DATABASE_URL: databaseUrl };
  it.each([
    [{}, 0],
    [{ ...validEnv, DOWNTOWN_U_OPERATOR_ENABLED: "0" }, 0],
    [{ ...validEnv, DOWNTOWN_U_OPERATOR_AUTH_SECRET: undefined }, 0],
  ] as const)("returns 503 for missing/disabled configuration without opening a pool", async (env, expectedPools) => {
    const getPool = vi.fn(() => { throw new Error("pool"); }); const createStore = vi.fn(); const output = response();
    await createProductionOperatorReadHandler("students", () => env as NodeJS.ProcessEnv, { getPool, createStore: createStore as never })(request(), output.response);
    expect(output.result.status).toBe(503); expect(getPool).toHaveBeenCalledTimes(expectedPools); expect(createStore).not.toHaveBeenCalled();
  });
  it("passes only inherited operator DB environment to pool boundary and never touches providers", async () => {
    const pool = {} as never; const read = vi.fn().mockResolvedValue({ outcome: "authorized", items: [] });
    const getPool = vi.fn((env: NodeJS.ProcessEnv) => { expect(env.DOWNTOWN_U_OPERATOR_DATABASE_URL).toBe(databaseUrl); return pool; });
    const createStore = vi.fn(() => ({ read })); const output = response();
    await createProductionOperatorReadHandler("students", () => ({ ...validEnv }), { getPool, createStore })(request(), output.response);
    expect(output.result.status).toBe(200); expect(getPool).toHaveBeenCalledOnce(); expect(createStore).toHaveBeenCalledWith(pool);
  });
});
