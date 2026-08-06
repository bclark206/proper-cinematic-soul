import { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OperatorAuthService } from "../../../../server/downtown-u/operator/auth-service";
import {
  createOperatorAuthHandler,
  createProductionOperatorAuthHandler,
  type NodeOperatorAuthResponse,
  type OperatorAuthComposition,
} from "../auth-handler";
import * as requestLinkRoute from "../auth/request-link";
import * as verifyEmailRoute from "../auth/verify-email";
import * as verifySmsRoute from "../auth/verify-sms";
import * as sessionRoute from "../auth/session";
import * as logoutRoute from "../auth/logout";
import * as reauthRequestRoute from "../auth/reauth/request";
import * as reauthVerifyRoute from "../auth/reauth/verify";

const origin = "https://app.example.test";
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const uuid2 = "223e4567-e89b-42d3-a456-426614174000";
const bearer = "A".repeat(43);
const cookie = `__Host-downtown_u_operator_session=v1.${uuid}.${bearer}`;

function request(method: string, body?: unknown, extra: Record<string, string> = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(bytes), {
    method,
    headers: { ...(method === "POST" ? { origin, "content-type": "application/json" } : {}), ...extra },
  });
}
function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const adapter: NodeOperatorAuthResponse = {
    setHeader: (name, value) => { result.headers[name] = value; },
    status: (status) => ({ json: (body) => { result.status = status; result.body = body; }, end: () => { result.status = status; } }),
  };
  return { result, adapter };
}
function service(overrides: Record<string, unknown> = {}) {
  return {
    requestLink: vi.fn().mockResolvedValue({ accepted: true }),
    verifyEmail: vi.fn().mockResolvedValue({ authenticated: false }),
    verifySms: vi.fn().mockResolvedValue({ authenticated: false }),
    session: vi.fn().mockResolvedValue({ authenticated: false }),
    logout: vi.fn().mockResolvedValue({ success: true }),
    requestReauth: vi.fn().mockResolvedValue({ authenticated: false }),
    verifyReauth: vi.fn().mockResolvedValue({ reauthenticated: false }),
    ...overrides,
  } as unknown as OperatorAuthService;
}
function factory(auth: OperatorAuthService, now = new Date("2026-08-05T00:00:00Z")) {
  return vi.fn(async (): Promise<OperatorAuthComposition> => ({ service: auth, now: () => now }));
}
async function invoke(endpoint: Parameters<typeof createOperatorAuthHandler>[0], auth: OperatorAuthService,
  req: ReturnType<typeof request>, now?: Date) {
  const output = response(); const make = factory(auth, now);
  await createOperatorAuthHandler(endpoint, origin, make)(req, output.adapter);
  return { ...output, make };
}

const successHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

describe("operator auth API adapter", () => {
  it("keeps request-link enumeration invariant and composes only after a valid raw parse", async () => {
    const auth = service(); const make = factory(auth);
    const handler = createOperatorAuthHandler("request-link", origin, make);
    for (const raw of [Buffer.from("{"), Buffer.from([0xff]), Buffer.from(JSON.stringify({ email: "BAD" }))]) {
      const out = response();
      const req = Object.assign(Readable.from([raw]), { method: "POST", headers: { origin, "content-type": "application/json" } });
      await handler(req, out.adapter);
      expect(out.result).toMatchObject({ status: 202, body: { accepted: true }, headers: successHeaders });
    }
    expect(make).not.toHaveBeenCalled(); expect(auth.requestLink).not.toHaveBeenCalled();
    const out = response(); await handler(request("POST", { email: "operator@example.test" }), out.adapter);
    expect(auth.requestLink).toHaveBeenCalledWith("operator@example.test", expect.objectContaining({ origin }));
    expect(make).toHaveBeenCalledOnce();
  });

  it("maps email verification success, invalid and unavailable to exact public bodies", async () => {
    for (const [result, status, body] of [
      [{ mfaRequired: true, smsChallengeId: uuid2 }, 200, { mfaRequired: true, smsChallengeId: uuid2 }],
      [{ authenticated: false }, 401, { authenticated: false }],
      [{ unavailable: true }, 503, { error: "unavailable" }],
    ] as const) {
      const auth = service({ verifyEmail: vi.fn().mockResolvedValue(result) });
      const out = await invoke("verify-email", auth, request("POST", { flowId: uuid, flowVerifier: bearer, challengeId: uuid2, verifier: bearer }));
      expect(out.result).toMatchObject({ status, body });
      expect(Object.keys(out.result.body as object)).toEqual(Object.keys(body));
    }
  });

  it("sets the exact host cookie, upper-clamps TTL, and exposes only the nested public operator", async () => {
    for (const [absolute, ttl] of [["2026-08-05T09:00:00Z", 28800], ["2026-08-05T00:00:01.900Z", 1]] as const) {
      const wrapped = { public: { authenticated: true, displayName: "Operator", roles: ["admin"] } } as Record<string, unknown>;
      Object.defineProperty(wrapped, "cookie", { enumerable: false, value: { sessionId: uuid, bearer, absoluteExpiresAt: new Date(absolute) } });
      const auth = service({ verifySms: vi.fn().mockResolvedValue(wrapped) });
      const out = await invoke("verify-sms", auth, request("POST", { flowId: uuid, flowVerifier: bearer, challengeId: uuid2, otp: "123456" }));
      expect(out.result.status).toBe(200);
      expect(out.result.body).toEqual({ authenticated: true, operator: { displayName: "Operator", roles: ["admin"] } });
      expect(out.result.headers["Set-Cookie"]).toBe(`__Host-downtown_u_operator_session=v1.${uuid}.${bearer}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=Strict`);
      expect(JSON.stringify(out.result)).not.toMatch(/sessionId|bearer|operatorId|email|phone/);
    }
  });

  it("rejects malformed authenticated service results whose cookie has no whole second remaining", async () => {
    for (const absolute of ["2026-08-04T23:59:59Z", "2026-08-05T00:00:00Z", "2026-08-05T00:00:00.999Z"]) {
      const wrapped = { public: { authenticated: true, displayName: "Operator", roles: ["admin"] } } as Record<string, unknown>;
      Object.defineProperty(wrapped, "cookie", { enumerable: false, value: { sessionId: uuid, bearer, absoluteExpiresAt: new Date(absolute) } });
      const auth = service({ verifySms: vi.fn().mockResolvedValue(wrapped) });
      const out = await invoke("verify-sms", auth, request("POST", { flowId: uuid, flowVerifier: bearer, challengeId: uuid2, otp: "123456" }));
      expect(out.result).toMatchObject({ status: 401, body: { authenticated: false } });
      expect(out.result.headers["Set-Cookie"]).toBeUndefined();
    }
  });

  it("validates the single cookie and session through the service on every GET", async () => {
    const auth = service({ session: vi.fn().mockResolvedValue({ authenticated: true, displayName: "Operator", roles: ["admin"], smsReauthFresh: true }) });
    const handler = createOperatorAuthHandler("session", origin, factory(auth));
    for (let n = 0; n < 2; n++) {
      const out = response(); await handler(request("GET", undefined, { cookie }), out.adapter);
      expect(out.result).toMatchObject({ status: 200, body: { authenticated: true, operator: { displayName: "Operator", roles: ["admin"] }, smsReauthFresh: true } });
      expect(out.result.headers["Set-Cookie"]).toBeUndefined();
    }
    expect(auth.session).toHaveBeenCalledTimes(2);
    const invalid = response(); await handler(request("GET", undefined, { cookie: `${cookie}; ${cookie}` }), invalid.adapter);
    expect(invalid.result).toMatchObject({ status: 401, body: { authenticated: false } });
    expect(auth.session).toHaveBeenCalledTimes(2);
  });

  it("always clears logout cookies, including malformed boundaries and unavailable storage", async () => {
    const clear = "__Host-downtown_u_operator_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict";
    const unavailable = service({ logout: vi.fn().mockResolvedValue({ unavailable: true }) });
    const failed = await invoke("logout", unavailable, request("POST", {}, { cookie }));
    expect(failed.result).toMatchObject({ status: 503, body: { error: "unavailable" }, headers: { "Set-Cookie": clear } });
    const malformed = await invoke("logout", service(), request("PUT", {}, { cookie }));
    expect(malformed.result).toMatchObject({ status: 405, headers: { "Set-Cookie": clear } });
    const ok = await invoke("logout", service(), request("POST", {}, { cookie }));
    expect(ok.result.status).toBe(204); expect(ok.result.body).toBeUndefined(); expect(ok.result.headers["Set-Cookie"]).toBe(clear);
  });

  it("maps reauth request and verify with mandatory credentials and exact bodies", async () => {
    const started = service({ requestReauth: vi.fn().mockResolvedValue({ accepted: true }) });
    expect((await invoke("reauth-request", started, request("POST", {}, { cookie }))).result).toMatchObject({ status: 202, body: { accepted: true } });
    const verified = service({ verifyReauth: vi.fn().mockResolvedValue({ reauthenticated: true, validForSeconds: 300 }) });
    expect((await invoke("reauth-verify", verified, request("POST", { challengeId: uuid2, otp: "123456" }, { cookie }))).result)
      .toMatchObject({ status: 200, body: { reauthenticated: true, validForSeconds: 300 } });
    const noCookie = await invoke("reauth-request", started, request("POST", {}));
    expect(noCookie.result).toMatchObject({ status: 401, body: { authenticated: false } });
  });

  it("returns the exact Allow method and security headers for every injected and production 405 without composing", async () => {
    const endpoints = ["request-link", "verify-email", "verify-sms", "session", "logout", "reauth-request", "reauth-verify"] as const;
    for (const endpoint of endpoints) {
      const expected = endpoint === "session" ? "GET" : "POST";
      const wrong = expected === "GET" ? "POST" : "GET";
      const make = factory(service());
      const injected = response();
      await createOperatorAuthHandler(endpoint, origin, make)(request(wrong), injected.adapter);
      expect(injected.result).toMatchObject({ status: 405, body: { error: "invalid_request" },
        headers: { ...successHeaders, Allow: expected } });
      expect(make).not.toHaveBeenCalled();

      const readEnvironment = vi.fn(() => { throw new Error("must not compose"); });
      const production = response();
      await createProductionOperatorAuthHandler(endpoint, readEnvironment)(request(wrong), production.adapter);
      expect(production.result).toMatchObject({ status: 405, body: { error: "invalid_request" },
        headers: { ...successHeaders, Allow: expected } });
      expect(readEnvironment).not.toHaveBeenCalled();
    }
  });

  it("has exactly seven function artifacts at the rewritten filesystem paths before the SPA catch-all", () => {
    const routes = [
      ["request-link", requestLinkRoute],
      ["verify-email", verifyEmailRoute],
      ["verify-sms", verifySmsRoute],
      ["session", sessionRoute],
      ["logout", logoutRoute],
      ["reauth/request", reauthRequestRoute],
      ["reauth/verify", reauthVerifyRoute],
    ] as const;
    for (const [, module] of routes) {
      expect(module.default).toBeTypeOf("function");
      expect(module.config).toEqual({ api: { bodyParser: false } });
    }
    for (const oldPath of ["request-link", "verify-email", "verify-sms", "session", "logout"]) {
      expect(existsSync(`${process.cwd()}/api/downtown-u/operator/${oldPath}.ts`)).toBe(false);
    }
    expect(existsSync(`${process.cwd()}/api/downtown-u/operator/reauth`)).toBe(false);
    const config = JSON.parse(readFileSync(`${process.cwd()}/vercel.json`, "utf8")) as { rewrites: Array<{ source: string; destination: string }> };
    const fallback = config.rewrites.findIndex((item) => item.source === "/(.*)" && item.destination === "/index.html");
    expect(fallback).toBeGreaterThanOrEqual(0);
    for (const [path] of routes) {
      const route = `/api/downtown-u/operator/auth/${path}`;
      const matches = config.rewrites
        .map((item, index) => ({ ...item, index }))
        .filter((item) => item.source === route);
      expect(matches).toEqual([{ source: route, destination: route, index: matches[0]?.index }]);
      expect(matches[0].index).toBeLessThan(fallback);
    }
  });
});
