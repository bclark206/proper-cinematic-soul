import { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createOperatorAuthCryptography } from "../../../../server/downtown-u/operator/auth-crypto";
import {
  createOperatorEligibilityHandler,
  createProductionOperatorEligibilityHandler,
  type NodeOperatorEligibilityResponse,
  type OperatorEligibilityComposition,
} from "../eligibility-handler";
import * as eligibilityRoute from "../eligibility-decisions";

const origin = "https://operator.example.test";
const endpoint = "/api/downtown-u/operator/eligibility-decisions";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const studentId = "223e4567-e89b-42d3-a456-426614174000";
const correlationUuid = "323e4567-e89b-42d3-a456-426614174000";
const auditId = "423e4567-e89b-42d3-a456-426614174000";
const eventId = "523e4567-e89b-42d3-a456-426614174000";
const idempotencyKey = "opm:v1:623e4567-e89b-42d3-a456-426614174000";
const expectedUpdatedAt = "2026-08-06T12:00:00.000Z";
const correlationId = `operator-mutation:${correlationUuid}`;
const bearer = "A".repeat(43);
const secret = "AyQ7Gu1FZ6fR1esxrvIGvIN8Yl-Bhb12oZSjgqU2xLY";
const cookie = `__Host-downtown_u_operator_session=v1.${sessionId}.${bearer}`;
const body = Object.freeze({
  studentId,
  expectedStatus: "pending",
  expectedUpdatedAt,
  decision: "approve",
  reasonCode: "documentation_verified",
  reason: "Documents verified",
});
const item = Object.freeze({
  studentId,
  eligibilityStatus: "approved",
  eligibilityReviewedAt: expectedUpdatedAt,
  approvedAt: expectedUpdatedAt,
  updatedAt: expectedUpdatedAt,
});

function request(
  raw: string | Uint8Array = JSON.stringify(body),
  overrides: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    cookie,
  };
  return Object.assign(Readable.from([raw]), {
    method: "POST",
    url: endpoint,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    ...overrides,
  });
}
function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const adapter: NodeOperatorEligibilityResponse = {
    setHeader(name: string, value: string) { result.headers[name] = value; },
    status(status: number) { return { json(value: unknown) { result.status = status; result.body = value; } }; },
  };
  return { result, adapter };
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

function setup(storeResult: unknown = { outcome: "updated", replayed: false, item }) {
  const mutate = vi.fn().mockResolvedValue(storeResult);
  const admit = vi.fn().mockResolvedValue({ outcome: "admitted" });
  const composition: OperatorEligibilityComposition = {
    store: { mutate },
    admission: { admit },
    cryptography: createOperatorAuthCryptography(secret),
  };
  const compose = vi.fn(async () => composition);
  const randomUUID = vi.fn()
    .mockReturnValueOnce(correlationUuid)
    .mockReturnValueOnce(auditId)
    .mockReturnValueOnce(eventId);
  const handler = createOperatorEligibilityHandler(origin, compose, { randomUUID });
  return { handler, mutate, admit, compose, randomUUID, composition };
}
async function invoke(setupResult = setup(), req = request()) {
  const output = response();
  await setupResult.handler(req, output.adapter);
  return output.result;
}

describe("operator eligibility mutation POST API", () => {
  it("returns the exact redacted success envelope, generated correlation and security headers", async () => {
    const s = setup();
    const result = await invoke(s);
    expect(result).toEqual({
      status: 200,
      body: { result: item, replayed: false },
      headers: {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "X-Correlation-ID": correlationId,
      },
    });
    expect(result.headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(s.randomUUID).toHaveBeenCalledTimes(3);
  });

  it("passes generated IDs, digest, exact parsed body and key to DB authority", async () => {
    const s = setup();
    await invoke(s);
    expect(s.mutate).toHaveBeenCalledOnce();
    expect(s.mutate).toHaveBeenCalledWith({
      sessionId,
      sessionVersion: 1,
      sessionDigest: expect.any(Buffer),
      correlationId,
      idempotencyKey,
      auditId,
      eventId,
      ...body,
    });
    const call = s.mutate.mock.calls[0][0];
    expect(call.sessionDigest).toHaveLength(32);
    expect(JSON.stringify(call)).not.toContain(bearer);
  });

  it("maps a same-key replay to the same item and replayed true", async () => {
    const s = setup({ outcome: "updated", replayed: true, item });
    const result = await invoke(s);
    expect(result).toMatchObject({ status: 200, body: { result: item, replayed: true } });
    expect(s.mutate).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey }));
  });

  it.each([
    ["invalid", 401, "unauthorized"],
    ["denied", 403, "forbidden"],
    ["reauth_required", 428, "reauth_required"],
    ["not_found", 404, "not_found"],
    ["stale_state", 409, "stale_state"],
    ["conflict", 409, "conflict"],
    ["idempotency_conflict", 409, "idempotency_conflict"],
  ])("maps DB-authoritative %s without current-state leakage", async (outcome, status, error) => {
    const s = setup({ outcome, replayed: false, item: null });
    const result = await invoke(s);
    expect(result).toMatchObject({ status, body: { error }, headers: { "X-Correlation-ID": correlationId, ...securityHeaders } });
    expect(result.body).toEqual({ error });
    expect(JSON.stringify(result)).not.toMatch(/"(?:expectedStatus|eligibilityStatus|current|reason|operatorId|sessionId)"/);
  });

  it("treats target transition conflicts as DB outcomes, not malformed requests", async () => {
    for (const outcome of ["stale_state", "conflict"] as const) {
      const s = setup({ outcome, replayed: false, item: null });
      const result = await invoke(s);
      expect(result.status).toBe(409);
      expect(s.mutate).toHaveBeenCalledOnce();
    }
  });

  it("admits only after safe parse and before DB, with pseudonymizable trusted data", async () => {
    const s = setup();
    await invoke(s);
    expect(s.admit).toHaveBeenCalledOnce();
    expect(s.admit).toHaveBeenCalledWith({
      sessionId,
      targetId: studentId,
      origin,
      secFetchSite: "same-origin",
      correlationId,
    });
    const admitted = JSON.stringify(s.admit.mock.calls[0][0]);
    expect(admitted).not.toContain(bearer);
    expect(admitted).not.toContain(body.reason);
    expect(admitted).not.toContain(idempotencyKey);
    expect(s.admit.mock.invocationCallOrder[0]).toBeLessThan(s.mutate.mock.invocationCallOrder[0]);
  });

  it.each([
    [{ outcome: "limited" }, 429, "rate_limited"],
    [{ outcome: "unavailable" }, 503, "unavailable"],
  ])("maps admission %# to %s and never calls store", async (admission, status, error) => {
    const s = setup(); s.admit.mockResolvedValue(admission);
    const result = await invoke(s);
    expect(result).toMatchObject({ status, body: { error }, headers: { "X-Correlation-ID": correlationId } });
    expect(s.mutate).not.toHaveBeenCalled();
  });

  it("maps thrown admission failures to unavailable and never calls store", async () => {
    const s = setup(); s.admit.mockRejectedValue(new Error("redis unavailable"));
    const result = await invoke(s);
    expect(result).toMatchObject({ status: 503, body: { error: "unavailable" }, headers: { "X-Correlation-ID": correlationId } });
    expect(s.mutate).not.toHaveBeenCalled();
  });

  it("generates audit/event IDs only after admission and preserves correlation on every post-boundary response", async () => {
    for (const outcome of ["limited", "unavailable"] as const) {
      const s = setup(); s.admit.mockResolvedValue({ outcome });
      const result = await invoke(s);
      expect(s.randomUUID).toHaveBeenCalledTimes(1);
      expect(result.headers["X-Correlation-ID"]).toBe(correlationId);
      expect(s.mutate).not.toHaveBeenCalled();
    }
    const admitted = setup();
    await invoke(admitted);
    expect(admitted.randomUUID).toHaveBeenCalledTimes(3);
    expect(admitted.randomUUID.mock.invocationCallOrder[0]).toBeLessThan(admitted.admit.mock.invocationCallOrder[0]);
    expect(admitted.randomUUID.mock.invocationCallOrder[1]).toBeGreaterThan(admitted.admit.mock.invocationCallOrder[0]);
    expect(admitted.randomUUID.mock.invocationCallOrder[2]).toBeGreaterThan(admitted.admit.mock.invocationCallOrder[0]);
  });

  it("does not compose, admit, digest, or store malformed boundary inputs", async () => {
    const cases = [
      request("{"),
      request(Buffer.from([0xff])),
      request(JSON.stringify({ ...body, correlationId: "client" })),
      request(JSON.stringify({ ...body, bearer })),
      request(JSON.stringify({ ...body, extra: true })),
      request(JSON.stringify({ ...body, studentId: studentId.toUpperCase() })),
      request(JSON.stringify({ ...body, reason: " untrimmed" })),
      request(`{"studentId":"${studentId}","expectedStatus":"pending","expectedUpdatedAt":"${expectedUpdatedAt}","decision":"approve","reasonCode":"documentation_verified","reason":"\\ud800"}`),
      request(JSON.stringify(body), { url: endpoint + "?x=1" }),
      request("x".repeat(8 * 1024 + 1)),
    ];
    for (const req of cases) {
      const s = setup(); const result = await invoke(s, req);
      expect(result).toMatchObject({ status: 400, body: { error: "invalid_request" }, headers: securityHeaders });
      expect(s.compose).not.toHaveBeenCalled();
      expect(s.admit).not.toHaveBeenCalled();
      expect(s.mutate).not.toHaveBeenCalled();
    }
  });

  it("maps cross-origin metadata to forbidden with no CORS and no composition", async () => {
    for (const [name, value] of [["origin", "https://evil.test"], ["sec-fetch-site", "cross-site"]]) {
      const req = request(); req.headers[name] = value; req.rawHeaders = Object.entries(req.headers).flat();
      const s = setup(); const result = await invoke(s, req);
      expect(result).toMatchObject({ status: 403, body: { error: "forbidden" }, headers: securityHeaders });
      expect(result.headers).not.toHaveProperty("Access-Control-Allow-Origin");
      expect(s.compose).not.toHaveBeenCalled();
    }
  });

  it("rejects missing/duplicate cookie and client bearer without touching DB", async () => {
    for (const cookieValue of [undefined, `${cookie}; ${cookie}`, `bearer=${bearer}`]) {
      const req = request();
      if (cookieValue === undefined) delete req.headers.cookie; else req.headers.cookie = cookieValue;
      req.rawHeaders = Object.entries(req.headers).flat();
      const s = setup(); const result = await invoke(s, req);
      expect(result).toMatchObject({ status: 401, body: { error: "unauthorized" } });
      expect(s.mutate).not.toHaveBeenCalled();
    }
  });

  it("returns 405 Allow POST before composition for every wrong method", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "post", ""] ) {
      const s = setup(); const result = await invoke(s, request(undefined as never, { method }));
      expect(result).toMatchObject({
        status: 405,
        body: { error: "method_not_allowed" },
        headers: { ...securityHeaders, Allow: "POST" },
      });
      expect(s.compose).not.toHaveBeenCalled();
      expect(s.randomUUID).not.toHaveBeenCalled();
    }
  });

  it("fails malformed method/header/proxy descriptors closed without getter invocation", async () => {
    for (const key of ["method", "url", "headers", "rawHeaders"]) {
      const getter = vi.fn(() => key === "method" ? "POST" : undefined);
      const req = request(); Object.defineProperty(req, key, { get: getter, configurable: true });
      const s = setup(); const result = await invoke(s, req);
      expect(result).toMatchObject({ status: 400, body: { error: "invalid_request" } });
      expect(getter).not.toHaveBeenCalled();
      expect(s.compose).not.toHaveBeenCalled();
    }
  });

  it("rejects request/header/raw-header proxies with zero traps and no composition", async () => {
    for (const boundary of ["request", "headers", "rawHeaders"] as const) {
      const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
      const hostile = new Proxy(boundary === "rawHeaders" ? [] : {}, {
        get() { counts.get++; throw new Error("get trap"); },
        getPrototypeOf() { counts.getPrototypeOf++; throw new Error("prototype trap"); },
        ownKeys() { counts.ownKeys++; throw new Error("keys trap"); },
        getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor++; throw new Error("descriptor trap"); },
      });
      const req: Record<PropertyKey, unknown> = boundary === "request" ? hostile : request();
      if (boundary !== "request") req[boundary] = hostile;
      const s = setup(); const result = await invoke(s, req as never);
      expect(result).toMatchObject({ status: 400, body: { error: "invalid_request" } });
      expect(counts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
      expect(s.compose).not.toHaveBeenCalled();
    }
  });

  it("maps composition, digest, UUID generation, store throw and hostile output to unavailable", async () => {
    const cases: ReturnType<typeof setup>[] = [];
    const compose = setup(); compose.compose.mockRejectedValue(new Error("configuration")); cases.push(compose);
    const digest = setup(); digest.composition.cryptography = { digestSession() { throw new Error("crypto"); } } as never; cases.push(digest);
    const uuid = setup(); uuid.randomUUID.mockReset().mockImplementation(() => { throw new Error("entropy"); }); cases.push(uuid);
    const store = setup(); store.mutate.mockRejectedValue(new Error("database")); cases.push(store);
    const hostile = setup({ outcome: "updated", replayed: false, item: { ...item, reason: "must-not-leak" } }); cases.push(hostile);
    for (const s of cases) {
      const result = await invoke(s);
      expect(result).toMatchObject({ status: 503, body: { error: "unavailable" }, headers: securityHeaders });
      expect(JSON.stringify(result)).not.toMatch(/must-not-leak|database|entropy|crypto|configuration/);
    }
  });

  it("rejects admission and store-result proxies without invoking any trap", async () => {
    for (const stage of ["admission", "store"] as const) {
      const counts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
      const hostile = new Proxy({}, {
        get(_target, key) { if (key === "then") return undefined; counts.get++; throw new Error("get trap"); },
        getPrototypeOf() { counts.getPrototypeOf++; return null; },
        ownKeys() { counts.ownKeys++; return []; },
        getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor++; return undefined; },
      });
      const s = setup(stage === "store" ? hostile : undefined);
      if (stage === "admission") s.admit.mockResolvedValue(hostile);
      const result = await invoke(s);
      expect(result).toMatchObject({ status: 503, body: { error: "unavailable" } });
      expect(counts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    }
  });
});

describe("production eligibility mutation composition and route", () => {
  const validEnvironment = () => ({
    DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
    DOWNTOWN_U_OPERATOR_ENABLED: "1",
    DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: "1",
    DOWNTOWN_U_OPERATOR_AUTH_SECRET: secret,
    DOWNTOWN_U_OPERATOR_DATABASE_URL: "postgresql://operator:secret@db.example.test/app?sslmode=verify-full&channel_binding=require",
    DATABASE_URL: "postgresql://wrong:wrong@wrong.example.test/wrong",
  } as NodeJS.ProcessEnv);

  it.each([
    { DOWNTOWN_U_OPERATOR_ENABLED: "true" },
    { DOWNTOWN_U_OPERATOR_ENABLED: "0" },
    { DOWNTOWN_U_OPERATOR_ENABLED: undefined },
    { DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: "0" },
    { DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: undefined },
  ])("requires both exact environment gates before pool/admission %#", async (change) => {
    const getPool = vi.fn(); const createStore = vi.fn(); const createAdmission = vi.fn();
    const environment = vi.fn(() => ({ ...validEnvironment(), ...change }));
    const output = response();
    await createProductionOperatorEligibilityHandler(environment, { getPool, createStore, createAdmission } as never)(request(), output.adapter);
    expect(output.result).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(getPool).not.toHaveBeenCalled(); expect(createStore).not.toHaveBeenCalled(); expect(createAdmission).not.toHaveBeenCalled();
  });

  it("validates dedicated DB URL and all config before crossing pool boundary", async () => {
    const getPool = vi.fn(); const createStore = vi.fn(); const createAdmission = vi.fn();
    const environment = () => ({ ...validEnvironment(), DOWNTOWN_U_OPERATOR_DATABASE_URL: "postgres://malformed" });
    const output = response();
    await createProductionOperatorEligibilityHandler(environment, { getPool, createStore, createAdmission } as never)(request(), output.adapter);
    expect(output.result).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(getPool).not.toHaveBeenCalled(); expect(createStore).not.toHaveBeenCalled(); expect(createAdmission).not.toHaveBeenCalled();
  });

  it("uses only the dedicated operator credential and composes lazily after valid boundary", async () => {
    const mutate = vi.fn().mockResolvedValue({ outcome: "updated", replayed: false, item });
    const admit = vi.fn().mockResolvedValue({ outcome: "admitted" });
    const pool = { dedicated: true };
    const getPool = vi.fn(() => pool); const createStore = vi.fn(() => ({ mutate })); const createAdmission = vi.fn(() => ({ admit }));
    const environment = vi.fn(validEnvironment);
    const handler = createProductionOperatorEligibilityHandler(environment, { getPool, createStore, createAdmission } as never);
    expect(environment).not.toHaveBeenCalled(); expect(getPool).not.toHaveBeenCalled();
    const bad = response(); await handler(request("{"), bad.adapter);
    expect(bad.result.status).toBe(400); expect(environment).not.toHaveBeenCalled(); expect(getPool).not.toHaveBeenCalled();
    const good = response(); await handler(request(), good.adapter);
    expect(good.result.status).toBe(200);
    expect(getPool).toHaveBeenCalledWith(expect.objectContaining({ DOWNTOWN_U_OPERATOR_DATABASE_URL: expect.stringContaining("operator:secret") }));
    expect(createStore).toHaveBeenCalledWith(pool);
    expect(createAdmission).toHaveBeenCalled();
  });

  it("has no Square imports or network calls in the narrow server/API mutation surface", () => {
    for (const path of [
      "server/downtown-u/operator/eligibility-http.ts",
      "server/downtown-u/operator/eligibility-types.ts",
      "server/downtown-u/operator/postgres-eligibility-store.ts",
      "api/downtown-u/operator/eligibility-handler.ts",
      "api/downtown-u/operator/eligibility-decisions.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/square|fetch\s*\(|https?:\/\//i);
    }
  });

  it("ships one bodyParser-false route and one rewrite before the SPA catch-all", () => {
    expect(eligibilityRoute.default).toBeTypeOf("function");
    expect(eligibilityRoute.config).toEqual({ api: { bodyParser: false } });
    expect(existsSync("api/downtown-u/operator/eligibility-decisions.ts")).toBe(true);
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { rewrites: Array<{ source: string; destination: string }> };
    const matches = config.rewrites.map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.source === endpoint && entry.destination === endpoint);
    const fallback = config.rewrites.findIndex((entry) => entry.source === "/(.*)" && entry.destination === "/index.html");
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBeLessThan(fallback);
  });
});
