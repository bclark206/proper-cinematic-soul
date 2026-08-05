import { describe, expect, it, vi } from "vitest";
import {
  AUTH_ACTOR_LIMIT, AUTH_ACTOR_WINDOW_SECONDS, AUTH_GLOBAL_LIMIT, AUTH_GLOBAL_WINDOW_SECONDS,
  AuthAdmissionConfigurationError, AuthAdmissionError, createAuthRequestAdmissionGuard,
} from "../auth-admission";

const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
const baseEnv = {
  VERCEL: "1",
  DOWNTOWN_U_AUTH_SECRET: secret,
  UPSTASH_REDIS_REST_URL: "https://downtown-u-guard.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "redis-secret-token",
};
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("deployment-wide auth request admission", () => {
  it("accepts one trusted Vercel IPv4/IPv6 value and HMACs it before Redis", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]); return jsonResponse({ result: 1 });
    });
    const guard = createAuthRequestAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    await expect(guard.admit({ "x-vercel-forwarded-for": "203.0.113.7" })).resolves.toBe(true);
    await expect(guard.admit({ "X-Vercel-Forwarded-For": "2001:db8::7" })).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(url).toBe("https://downtown-u-guard.upstash.io/eval");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer redis-secret-token");
      const body = String(init?.body);
      expect(body).not.toMatch(/203\.0\.113\.7|2001:db8|redis-secret-token|^[^[]*secret/i);
      const command = JSON.parse(body) as string[];
      expect(command).toHaveLength(3);
      expect(command[0]).toContain("redis.call('TIME')");
      expect(command[0]).toContain(String(AUTH_ACTOR_LIMIT));
      expect(command[0]).toContain(String(AUTH_GLOBAL_LIMIT));
      expect(command[0]).toContain(String(AUTH_ACTOR_WINDOW_SECONDS));
      expect(command[0]).toContain(String(AUTH_GLOBAL_WINDOW_SECONDS));
      expect(command[1]).toBe("0");
      expect(command[2]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect((JSON.parse(String(calls[0][1]?.body)) as string[])[2])
      .not.toBe((JSON.parse(String(calls[1][1]?.body)) as string[])[2]);
  });

  it("suppresses missing, ambiguous, malformed, and spoof-prone actor input without Redis", async () => {
    const fetchMock = vi.fn(); const guard = createAuthRequestAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    for (const headers of [{}, { "x-forwarded-for": "203.0.113.7" },
      { "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.2" },
      { "x-vercel-forwarded-for": ["203.0.113.7", "198.51.100.2"] },
      { "x-vercel-forwarded-for": "203.0.113.999" },
      { "x-vercel-forwarded-for": " 203.0.113.7 " },
    ]) await expect(guard.admit(headers)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("embeds fixed conservative limits/windows in one atomic EVAL with no caller limits", async () => {
    expect({ actor: AUTH_ACTOR_LIMIT, actorWindow: AUTH_ACTOR_WINDOW_SECONDS,
      global: AUTH_GLOBAL_LIMIT, globalWindow: AUTH_GLOBAL_WINDOW_SECONDS })
      .toEqual({ actor: 5, actorWindow: 900, global: 100, globalWindow: 300 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: 0 }));
    const guard = createAuthRequestAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    await expect(guard.admit({ "x-vercel-forwarded-for": "203.0.113.8" })).resolves.toBe(false);
    const command = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as string[];
    expect(command[0]).toMatch(/du:auth:actor:v1:/);
    expect(command[0]).toMatch(/du:auth:global:v1:/);
    expect(command[0]).toContain("INCR");
    expect(command[0]).toContain("EXPIRE");
    expect(command.slice(1)).toHaveLength(2);
  });

  it("enforces actor and deployment-global ceilings across contacts and rotating actors", async () => {
    const actors = new Map<string, number>(); let global = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const actor = (JSON.parse(String(init?.body)) as string[])[2];
      const actorCount = actors.get(actor) ?? 0;
      if (actorCount >= AUTH_ACTOR_LIMIT || global >= AUTH_GLOBAL_LIMIT) return jsonResponse({ result: 0 });
      actors.set(actor, actorCount + 1); global += 1; return jsonResponse({ result: 1 });
    });
    const guard = createAuthRequestAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    const sameActorResults = [];
    // Contact is intentionally absent from guard input: arbitrarily rotating contact
    // values cannot rotate this trusted network actor pseudonym.
    for (let index = 0; index < AUTH_ACTOR_LIMIT + 1; index++) {
      sameActorResults.push(await guard.admit({ "x-vercel-forwarded-for": "203.0.113.10" }));
    }
    expect(sameActorResults).toEqual([true, true, true, true, true, false]);

    let rotatingAdmitted = 0; let rotatingBlocked = 0;
    for (let index = 1; index <= AUTH_GLOBAL_LIMIT; index++) {
      const admitted = await guard.admit({ "x-vercel-forwarded-for": `2001:db8::${index.toString(16)}` });
      if (admitted) rotatingAdmitted++; else rotatingBlocked++;
    }
    expect(rotatingAdmitted).toBe(AUTH_GLOBAL_LIMIT - AUTH_ACTOR_LIMIT);
    expect(rotatingBlocked).toBe(AUTH_ACTOR_LIMIT);
    expect(global).toBe(AUTH_GLOBAL_LIMIT);
  });

  it("fails closed generically on timeout, non-2xx, oversized, and malformed Redis responses", async () => {
    const failures = [
      vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
      vi.fn().mockResolvedValue(jsonResponse({ result: 1 }, 503)),
      vi.fn().mockResolvedValue(new Response("x".repeat(4_097))),
      vi.fn().mockResolvedValue(new Response("not-json")),
      vi.fn().mockResolvedValue(jsonResponse({ result: "1" })),
    ];
    for (const fetchMock of failures) {
      const guard = createAuthRequestAdmissionGuard(baseEnv, fetchMock as typeof fetch, 5);
      await expect(guard.admit({ "x-vercel-forwarded-for": "203.0.113.9" })).resolves.toBe(false);
    }
  });

  it("rejects non-Vercel and SSRF-capable Redis configuration with generic errors", () => {
    for (const env of [
      { ...baseEnv, VERCEL: "0" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "http://downtown-u-guard.upstash.io" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "https://upstash.io.evil.test" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "https://user:pass@downtown-u-guard.upstash.io" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "https://downtown-u-guard.upstash.io/path" },
      { ...baseEnv, UPSTASH_REDIS_REST_TOKEN: "bad\r\ntoken" },
    ]) {
      expect(() => createAuthRequestAdmissionGuard(env)).toThrow(AuthAdmissionConfigurationError);
      try { createAuthRequestAdmissionGuard(env); } catch (error) {
        expect(String(error)).toBe("AuthAdmissionConfigurationError: Authentication request admission is not configured");
        expect(String(error)).not.toMatch(/upstash|token|http|secret/i);
      }
    }
    expect(new AuthAdmissionError().message).toBe("Authentication request admission failed");
  });
});
