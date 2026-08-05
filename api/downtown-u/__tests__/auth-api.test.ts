import { Readable } from "node:stream";
import type { Pool, PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DowntownUAuthService } from "../../../server/downtown-u/auth-service";
import type { AuthStore } from "../../../server/downtown-u/postgres-auth-store";
import { AUTH_HTTP_MAX_BODY_BYTES } from "../../../server/downtown-u/auth-http";
import {
  createAuthPoolCache, createNodeAuthHandler, createProductionAuthHandler, createProductionAuthService,
  createVercelBackgroundScheduler,
  type NodeAuthResponse, type ProductionAuthBoundaries,
} from "../auth-handler";

const origin = "https://app.example.test";
const id = "A".repeat(43);
const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
const admissionGuard = { admit: vi.fn().mockResolvedValue(true) };
const scheduler = { schedule(work: () => Promise<void>) { work().catch(() => undefined); } };
function service() { return { request: vi.fn().mockResolvedValue({ accepted: true }), verify: vi.fn().mockResolvedValue({ outcome: "invalid" }) }; }
function store(overrides: Partial<AuthStore> = {}): AuthStore {
  return {
    createChallenge: vi.fn().mockResolvedValue({ outcome: "accepted" }),
    consumeChallenge: vi.fn().mockResolvedValue({ outcome: "invalid" }),
    validateSession: vi.fn().mockResolvedValue({ outcome: "invalid" }),
    revokeSession: vi.fn().mockResolvedValue({ outcome: "accepted" }),
    ...overrides,
  } as AuthStore;
}
function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const adapter: NodeAuthResponse = { setHeader: (name, value) => { result.headers[name] = value; },
    status: (status) => ({ json: (body) => { result.status = status; result.body = body; }, end: () => { result.status = status; } }) };
  return { result, adapter };
}
function stream(bytes: Buffer, headers: Record<string, string> = { "content-type": "application/json", origin }) {
  return Object.assign(Readable.from([bytes]), { method: "POST", headers });
}

const exactFailure = {
  "request-link": { status: 202, body: { accepted: true } },
  "send-code": { status: 202, body: { accepted: true } },
  "verify-code": { status: 401, body: { authenticated: false } },
} as const;

describe("Node/Vercel auth adapter", () => {
  it("parses exact raw JSON and maps malformed UTF-8 endpoint-invariantly", async () => {
    const dependency = service(); const handler = createNodeAuthHandler("request-link", dependency as never, origin, admissionGuard, scheduler);
    const ok = response(); await handler(stream(Buffer.from('{"email":"student@example.test"}')) as never, ok.adapter);
    expect(ok.result.status).toBe(202); expect(dependency.request).toHaveBeenCalledWith("email", "student@example.test");

    for (const endpoint of ["request-link", "send-code", "verify-code"] as const) {
      const invalid = response();
      await createNodeAuthHandler(endpoint, service() as never, origin, admissionGuard, scheduler)(stream(Buffer.from([0xff])) as never, invalid.adapter);
      expect(invalid.result).toMatchObject(exactFailure[endpoint]);
      expect(invalid.result.headers["Access-Control-Allow-Origin"]).toBe(origin);
      expect(invalid.result.headers["Set-Cookie"]).toBeUndefined();
    }
  });

  it("returns endpoint-invariant responses for oversized streams and cancels them", async () => {
    for (const endpoint of ["request-link", "send-code", "verify-code"] as const) {
      const request = stream(Buffer.alloc(AUTH_HTTP_MAX_BODY_BYTES + 1, 0x20));
      const res = response();
      await createNodeAuthHandler(endpoint, service() as never, origin, admissionGuard, scheduler)(request as never, res.adapter);
      expect(res.result).toMatchObject(exactFailure[endpoint]);
      expect(res.result.headers["Access-Control-Allow-Origin"]).toBe(origin);
      expect(request.destroyed).toBe(true);
      expect(res.result.headers["Set-Cookie"]).toBeUndefined();
    }
  });

  it("checks method/content type/origin before consuming the stream", async () => {
    const dependency = service(); const handler = createNodeAuthHandler("send-code", dependency as never, origin, admissionGuard, scheduler);
    for (const [headers, status] of [[{ "content-type": "text/plain", origin }, 415],
      [{ "content-type": "application/json", origin: "https://evil.test" }, 403]] as const) {
      const read = vi.fn(); const request = { method: "POST", headers,
        [Symbol.asyncIterator]() { read(); throw new Error("must not consume"); } };
      const res = response(); await handler(request as never, res.adapter); expect(res.result.status).toBe(status); expect(read).not.toHaveBeenCalled();
    }
  });

  it("rejects every own parsed-body form without invoking accessors or touching streams", async () => {
    for (const endpoint of ["request-link", "verify-code"] as const) {
      const dependency = service(); const handler = createNodeAuthHandler(endpoint, dependency as never, origin, admissionGuard, scheduler);
      for (const kind of ["data", "accessor"] as const) {
        const read = vi.fn(); const getter = vi.fn(() => { throw new Error("must not run"); });
        const request = { method: "POST", headers: { "content-type": "application/json", origin },
          [Symbol.asyncIterator]() { read(); throw new Error("must not consume"); } };
        if (kind === "data") Object.defineProperty(request, "body", { value: { email: "victim@example.test" }, enumerable: true });
        else Object.defineProperty(request, "body", { get: getter, enumerable: true });
        const res = response(); await handler(request as never, res.adapter);
        expect(res.result).toMatchObject(exactFailure[endpoint]);
        expect(read).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
        expect(dependency.request).not.toHaveBeenCalled(); expect(dependency.verify).not.toHaveBeenCalled();
      }
    }
  });

  it("ignores inherited body properties and reads the raw stream", async () => {
    const getter = vi.fn(() => ({ email: "attacker@example.test" }));
    const prototype = {}; Object.defineProperty(prototype, "body", { get: getter });
    const request = Object.assign(Object.create(prototype) as Record<PropertyKey, unknown>, {
      method: "POST", headers: { "content-type": "application/json", origin },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"email":"raw@example.test"}'); },
    });
    const dependency = service(); const res = response();
    await createNodeAuthHandler("request-link", dependency as never, origin, admissionGuard, scheduler)(request as never, res.adapter);
    expect(res.result).toMatchObject({ status: 202, body: { accepted: true } });
    expect(dependency.request).toHaveBeenCalledWith("email", "raw@example.test");
    expect(getter).not.toHaveBeenCalled();
  });

  it("fails closed on an ended stream without reading it", async () => {
    for (const ended of [true, "accessor"] as const) {
      const read = vi.fn(); const getter = vi.fn(() => true);
      const request = { method: "POST", headers: { "content-type": "application/json", origin },
        [Symbol.asyncIterator]() { read(); throw new Error("must not consume"); } };
      if (ended === true) Object.defineProperty(request, "readableEnded", { value: true });
      else Object.defineProperty(request, "readableEnded", { get: getter });
      const res = response(); await createNodeAuthHandler("verify-code", service() as never, origin, admissionGuard, scheduler)(request as never, res.adapter);
      expect(res.result).toMatchObject(exactFailure["verify-code"]);
      expect(read).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    }
  });

  it("composes production lazily once and returns generic responses for configuration failure", async () => {
    const dependency = service(); const authStore = store(); const pool = {} as Pool;
    const boundaries: ProductionAuthBoundaries = { getPool: vi.fn().mockReturnValue(pool), createStore: vi.fn().mockReturnValue(authStore),
      createService: vi.fn().mockReturnValue(dependency as unknown as DowntownUAuthService),
      createAdmissionGuard: vi.fn().mockReturnValue(admissionGuard), scheduler };
    const env = { DATABASE_URL: "postgres://user@unused.test/db", DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin };
    const handler = createProductionAuthHandler("request-link", env, boundaries);
    expect(boundaries.getPool).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) { const res = response(); await handler(stream(Buffer.from("{}")) as never, res.adapter); expect(res.result.status).toBe(202); }
    expect(boundaries.getPool).toHaveBeenCalledOnce(); expect(boundaries.createService).toHaveBeenCalledOnce();
    expect(boundaries.createService).toHaveBeenCalledWith(authStore, env, "request-link");

    const brokenBoundaries = { ...boundaries, createService: vi.fn(() => { throw new Error("provider-secret config"); }) };
    const invariant = createProductionAuthHandler("request-link", env, brokenBoundaries);
    const accepted = response(); await invariant(stream(Buffer.from("{}")) as never, accepted.adapter);
    expect(accepted.result).toMatchObject(exactFailure["request-link"]);

    const unavailable = createProductionAuthHandler("verify-code", {}, boundaries); const res = response();
    await unavailable(stream(Buffer.from(`{"challengeId":"${id}","verifier":"123456"}`), { "content-type": "application/json" }) as never, res.adapter);
    expect(res.result).toMatchObject(exactFailure["verify-code"]);
    expect(res.result.headers["Set-Cookie"]).toBeUndefined();
    expect(JSON.stringify(res.result)).not.toMatch(/postgres|secret/i);
  });

  it("composes each endpoint with only its own delivery requirements", async () => {
    const authStore = store();
    expect(() => createProductionAuthService(authStore, {
      DOWNTOWN_U_AUTH_SECRET: authSecret, DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
      RESEND_API_KEY: "resend-key", DOWNTOWN_U_AUTH_EMAIL_FROM: "auth@example.test",
    }, "request-link")).not.toThrow();
    expect(() => createProductionAuthService(authStore, {
      DOWNTOWN_U_AUTH_SECRET: authSecret, TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "twilio-key", DOWNTOWN_U_AUTH_SMS_FROM: "+12025550199",
    }, "send-code")).not.toThrow();
    const verifier = createProductionAuthService(authStore, { DOWNTOWN_U_AUTH_SECRET: authSecret }, "verify-code");
    await expect(verifier.verify(id, "123456")).resolves.toEqual({ outcome: "invalid" });

    expect(() => createProductionAuthService(authStore, {
      DOWNTOWN_U_AUTH_SECRET: authSecret, DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
    }, "request-link")).toThrow();
    expect(() => createProductionAuthService(authStore, { DOWNTOWN_U_AUTH_SECRET: authSecret }, "send-code")).toThrow();
  });

  it("keeps missing required providers request-invariant and verifies with no provider environment", async () => {
    for (const endpoint of ["request-link", "send-code"] as const) {
      const authStore = store(); const boundaries: ProductionAuthBoundaries = {
        getPool: vi.fn().mockReturnValue({} as Pool), createStore: vi.fn().mockReturnValue(authStore),
        createService: createProductionAuthService,
        createAdmissionGuard: vi.fn().mockReturnValue(admissionGuard), scheduler,
      };
      const handler = createProductionAuthHandler(endpoint, {
        DATABASE_URL: "postgres://user@unused.test/db", DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
        DOWNTOWN_U_AUTH_SECRET: authSecret,
        // The endpoint's required delivery provider is deliberately absent.
      }, boundaries);
      const field = endpoint === "request-link" ? "email" : "phone";
      const value = endpoint === "request-link" ? "student@example.test" : "+12025550100";
      const res = response(); await handler(stream(Buffer.from(JSON.stringify({ [field]: value }))) as never, res.adapter);
      expect(res.result).toMatchObject(exactFailure[endpoint]);
      expect(authStore.createChallenge).not.toHaveBeenCalled();
    }

    const authStore = store(); const boundaries: ProductionAuthBoundaries = {
      getPool: vi.fn().mockReturnValue({} as Pool), createStore: vi.fn().mockReturnValue(authStore),
      createService: createProductionAuthService,
      createAdmissionGuard: vi.fn().mockReturnValue(admissionGuard), scheduler,
    };
    const verify = createProductionAuthHandler("verify-code", {
      DATABASE_URL: "postgres://user@unused.test/db", DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
      DOWNTOWN_U_AUTH_SECRET: authSecret,
      // No Resend or Twilio variables.
    }, boundaries);
    const res = response();
    await verify(stream(Buffer.from(`{"challengeId":"${id}","verifier":"123456"}`)) as never, res.adapter);
    expect(res.result).toMatchObject(exactFailure["verify-code"]);
    expect(authStore.consumeChallenge).toHaveBeenCalledOnce();
    expect(res.result.headers["Set-Cookie"]).toBeUndefined();
  });

  it("hands scheduled work to Vercel waitUntil exactly once and never runs it synchronously", async () => {
    const retained: Promise<unknown>[] = [];
    const waitUntilImpl = vi.fn((promise: Promise<unknown>) => { retained.push(promise); });
    const background = vi.fn(async () => undefined);
    const backgroundScheduler = createVercelBackgroundScheduler(waitUntilImpl);

    backgroundScheduler.schedule(background);
    expect(waitUntilImpl).toHaveBeenCalledOnce();
    expect(background).not.toHaveBeenCalled();
    expect(retained).toHaveLength(1);
    await retained[0];
    expect(background).toHaveBeenCalledOnce();
  });

  it("isolates cached pools by canonical connection string while reusing identical databases", () => {
    const made: PoolConfig[] = [];
    const getPool = createAuthPoolCache((config) => { made.push(config); return { marker: made.length } as unknown as Pool; });
    const first = getPool("postgres://user:password@db.example.test/database");
    expect(getPool("postgres://user:password@db.example.test/database")).toBe(first);
    const second = getPool("postgres://user:password@db.example.test/other_database");
    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);
    expect(() => getPool("https://user:password@db.example.test/database")).toThrow("invalid database configuration");
  });
});
