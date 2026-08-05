import { describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_COOKIE, createAuthHttpHandler } from "../auth-http";

const origin = "https://app.example.test";
const id = "A".repeat(43); const token = "B".repeat(43);
const admissionGuard = { admit: vi.fn().mockResolvedValue(true) };
const scheduler = { schedule(work: () => Promise<void>) { work().catch(() => undefined); } };
function service() {
  return { request: vi.fn().mockResolvedValue({ accepted: true }), verify: vi.fn().mockResolvedValue({ outcome: "invalid" }) };
}
function request(body: unknown, overrides: Record<string, unknown> = {}) {
  return { method: "POST", headers: { "content-type": "application/json", origin }, body, ...overrides } as never;
}

describe("Downtown U auth HTTP boundary", () => {
  it.each([["request-link", "email", "Student@Example.com "], ["send-code", "phone", "(202) 555-0100"]] as const)(
    "keeps %s responses exact across accepted and failed service paths", async (endpoint, field, value) => {
      for (const behavior of ["resolve", "reject"] as const) {
        const dependency = service();
        if (behavior === "reject") dependency.request.mockRejectedValue(new Error("student@example.com db secret"));
        const handler = createAuthHttpHandler({ endpoint, service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler });
        const result = await handler(request({ [field]: value }));
        expect({ status: result.status, body: result.body }).toEqual({ status: 202, body: { accepted: true } });
        expect(JSON.stringify(result)).not.toMatch(/student@example|secret/i);
        expect(dependency.request).toHaveBeenCalledWith(field === "email" ? "email" : "phone", value);
      }
    },
  );

  it("returns constant 202 for malformed request schemas without evaluating accessors", async () => {
    const dependency = service(); const getter = vi.fn(() => { throw new Error("must not run"); });
    const accessor = {}; Object.defineProperty(accessor, "email", { enumerable: true, get: getter });
    const inherited = Object.create({ email: "victim@example.test" });
    const handler = createAuthHttpHandler({ endpoint: "request-link", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler });
    for (const body of [null, [], {}, { email: 1 }, { email: "a@b.test", extra: true }, accessor, inherited]) {
      const result = await handler(request(body)); expect(result.status).toBe(202); expect(result.body).toEqual({ accepted: true });
    }
    expect(getter).not.toHaveBeenCalled(); expect(dependency.request).not.toHaveBeenCalled();
  });

  it("enforces method, content type, origin and security headers", async () => {
    const dependency = service(); const handler = createAuthHttpHandler({ endpoint: "request-link", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler });
    expect((await handler(request({}, { method: "GET" }))).status).toBe(405);
    expect((await handler(request({}, { headers: { "content-type": "text/plain", origin } }))).status).toBe(415);
    expect((await handler(request({}, { headers: { "content-type": "application/json", origin: "https://evil.test" } }))).status).toBe(403);
    expect((await handler(request({}, { headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    const ok = await handler(request({ email: "a@b.test" }));
    expect(ok.headers).toMatchObject({ "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": origin });
  });

  it("sets only a bounded host cookie and boolean JSON after verification", async () => {
    const dependency = service(); dependency.verify.mockResolvedValue({ outcome: "authenticated", sessionId: id, bearerToken: token,
      studentId: "student-secret", expiresAt: new Date("2026-08-06T00:00:00Z") });
    const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler,
      now: () => new Date("2026-08-05T23:00:00Z") });
    const result = await handler(request({ challengeId: id, verifier: "123456" }));
    expect(result.status).toBe(200); expect(result.body).toEqual({ authenticated: true });
    expect(result.headers["Set-Cookie"]).toBe(`${AUTH_SESSION_COOKIE}=v1.${id}.${token}; Max-Age=3600; Path=/api/downtown-u; HttpOnly; Secure; SameSite=Strict`);
    expect(JSON.stringify(result.body)).not.toMatch(/student|AAAA|BBBB/);
    expect(result.headers["Set-Cookie"]).not.toContain("Domain=");
  });

  it("uses generic 401 without clearing an existing cookie for invalid formats/outcomes", async () => {
    const dependency = service(); const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler });
    for (const body of [{ challengeId: "bad\r\n", verifier: "123456" }, { challengeId: id, verifier: "12" }, { challengeId: id, verifier: "000000" }]) {
      const result = await handler(request(body));
      expect({ status: result.status, body: result.body }).toEqual({ status: 401, body: { authenticated: false } });
      expect(result.headers["Set-Cookie"]).toBeUndefined();
    }
    expect(dependency.verify).toHaveBeenCalledTimes(1);
  });

  it("maps every post-protocol verification failure to the exact generic 401", async () => {
    const dependency = service();
    dependency.verify.mockRejectedValue(new Error("database and secret details"));
    const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler });
    for (const body of [null, [], {}, { challengeId: id }, { challengeId: id, verifier: "123456", extra: true },
      { challengeId: id, verifier: "123456" }]) {
      const result = await handler(request(body));
      expect({ status: result.status, body: result.body }).toEqual({ status: 401, body: { authenticated: false } });
      expect(result.headers["Set-Cookie"]).toBeUndefined();
    }
    expect(dependency.verify).toHaveBeenCalledOnce();
  });

  it("validates cookie TTL boundaries and clamps only valid future expiries", async () => {
    const base = new Date("2026-08-05T00:00:00.000Z");
    const dependency = service();
    const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler,
      now: () => base });
    const offsets = [-1, 0, 999, Number.NaN];
    for (const offset of offsets) {
      dependency.verify.mockResolvedValueOnce({ outcome: "authenticated", sessionId: id, bearerToken: token,
        studentId: "hidden", expiresAt: new Date(base.getTime() + offset) });
      const result = await handler(request({ challengeId: id, verifier: "123456" }));
      expect({ status: result.status, body: result.body }).toEqual({ status: 401, body: { authenticated: false } });
      expect(result.headers["Set-Cookie"]).toBeUndefined();
    }

    for (const [offset, expectedTtl] of [[1_000, 1], [1_999, 1], [86_400_000, 86_400], [172_800_000, 86_400]] as const) {
      dependency.verify.mockResolvedValueOnce({ outcome: "authenticated", sessionId: id, bearerToken: token,
        studentId: "hidden", expiresAt: new Date(base.getTime() + offset) });
      const result = await handler(request({ challengeId: id, verifier: "123456" }));
      expect(result.status).toBe(200);
      expect(result.headers["Set-Cookie"]).toContain(`Max-Age=${expectedTtl};`);
    }
  });

  it("fails a non-finite clock closed without setting a cookie", async () => {
    const dependency = service(); dependency.verify.mockResolvedValue({ outcome: "authenticated", sessionId: id,
      bearerToken: token, studentId: "hidden", expiresAt: new Date("2026-08-06T00:00:00Z") });
    const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never, allowedOrigin: origin, admissionGuard, scheduler,
      now: () => new Date(Number.NaN) });
    const result = await handler(request({ challengeId: id, verifier: "123456" }));
    expect({ status: result.status, body: result.body }).toEqual({ status: 401, body: { authenticated: false } });
    expect(result.headers["Set-Cookie"]).toBeUndefined();
  });

  it.each([["request-link", "email", "student@example.test"], ["send-code", "phone", "+12025550100"]] as const)(
    "admits and schedules %s exactly once without awaiting delivery", async (endpoint, field, value) => {
      let release!: () => void;
      const providerDeferred = new Promise<void>((resolve) => { release = resolve; });
      const dependency = service(); dependency.request.mockReturnValue(providerDeferred.then(() => ({ accepted: true })));
      const work: Array<() => Promise<void>> = [];
      const injectedScheduler = { schedule: vi.fn((task: () => Promise<void>) => { work.push(task); }) };
      const guard = { admit: vi.fn().mockResolvedValue(true) };
      const handler = createAuthHttpHandler({ endpoint, service: dependency as never, allowedOrigin: origin,
        admissionGuard: guard, scheduler: injectedScheduler });

      const result = await handler(request({ [field]: value }, { headers: {
        "content-type": "application/json", origin, "x-vercel-forwarded-for": "203.0.113.7",
      } }));
      expect({ status: result.status, body: result.body }).toEqual({ status: 202, body: { accepted: true } });
      expect(guard.admit).toHaveBeenCalledOnce(); expect(injectedScheduler.schedule).toHaveBeenCalledOnce();
      expect(dependency.request).not.toHaveBeenCalled(); expect(work).toHaveLength(1);
      const background = work[0]();
      await Promise.resolve(); expect(dependency.request).toHaveBeenCalledOnce();
      let settled = false; background.then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      release(); await background; expect(settled).toBe(true);
    },
  );

  it("makes blocked and scheduler-failure request paths the same exact 202 without work", async () => {
    for (const behavior of ["blocked", "guard-error", "scheduler-error"] as const) {
      const dependency = service();
      const guard = { admit: behavior === "guard-error" ? vi.fn().mockRejectedValue(new Error("private actor"))
        : vi.fn().mockResolvedValue(behavior !== "blocked") };
      const injectedScheduler = { schedule: vi.fn(() => {
        if (behavior === "scheduler-error") throw new Error("scheduler internals");
      }) };
      const handler = createAuthHttpHandler({ endpoint: "request-link", service: dependency as never,
        allowedOrigin: origin, admissionGuard: guard, scheduler: injectedScheduler });
      const result = await handler(request({ email: "student@example.test" }));
      expect({ status: result.status, body: result.body }).toEqual({ status: 202, body: { accepted: true } });
      expect(dependency.request).not.toHaveBeenCalled();
      expect(injectedScheduler.schedule).toHaveBeenCalledTimes(behavior === "blocked" || behavior === "guard-error" ? 0 : 1);
    }
  });

  it("does not consult admission or scheduling for verification", async () => {
    const dependency = service();
    const guard = { admit: vi.fn(() => { throw new Error("must not run"); }) };
    const injectedScheduler = { schedule: vi.fn(() => { throw new Error("must not run"); }) };
    const handler = createAuthHttpHandler({ endpoint: "verify-code", service: dependency as never,
      allowedOrigin: origin, admissionGuard: guard, scheduler: injectedScheduler });
    await handler(request({ challengeId: id, verifier: "123456" }));
    expect(dependency.verify).toHaveBeenCalledOnce(); expect(guard.admit).not.toHaveBeenCalled();
    expect(injectedScheduler.schedule).not.toHaveBeenCalled();
  });
});
