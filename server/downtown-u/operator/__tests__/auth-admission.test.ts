import { describe, expect, it, vi } from "vitest";
import {
  OPERATOR_AUTH_ADMISSION_POLICIES,
  OperatorAuthAdmissionConfigurationError,
  createOperatorAuthAdmissionGuard,
} from "../auth-admission";

const baseEnv = {
  VERCEL: "1",
  DOWNTOWN_U_OPERATOR_AUTH_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url"),
  UPSTASH_REDIS_REST_URL: "https://operator-guard.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "redis-secret-token",
};
const headers = { "x-vercel-forwarded-for": "203.0.113.7" };
const sessionId = "123e4567-e89b-42d3-a456-426614174004";
const email = "operator@example.test";
const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });

describe("operator auth Upstash admission", () => {
  it("fixes the endpoint-specific limits and exact operator-only namespaces", () => {
    expect(OPERATOR_AUTH_ADMISSION_POLICIES).toEqual({
      requestLink: { actor: [5, 900], contact: [3, 900], global: [100, 300] },
      emailVerify: { actor: [10, 900] },
      smsVerify: { actor: [15, 900] },
      reauthIssuance: { actor: [5, 600], session: [3, 600] },
      reauthVerify: { actor: [15, 900], session: [10, 600] },
    });
  });

  it("uses one atomic EVAL per endpoint and sends only keyed pseudonyms", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init as RequestInit]);
      return jsonResponse({ result: 1 });
    });
    const guard = createOperatorAuthAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    await expect(guard.admitRequestLink(headers, email)).resolves.toBe(true);
    await expect(guard.admitEmailVerification(headers)).resolves.toBe(true);
    await expect(guard.admitSmsVerification(headers)).resolves.toBe(true);
    await expect(guard.admitReauthIssuance(headers, sessionId)).resolves.toBe(true);
    await expect(guard.admitReauthVerification(headers, sessionId)).resolves.toBe(true);
    expect(calls).toHaveLength(5);

    for (const [url, init] of calls) {
      expect(url).toBe("https://operator-guard.upstash.io/eval");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer redis-secret-token");
      const body = String(init.body);
      expect(body).not.toContain("203.0.113.7");
      expect(body).not.toContain(email);
      expect(body).not.toContain(sessionId);
      expect(body).not.toMatch(/phone|du:auth:|redis-secret-token/i);
      const command = JSON.parse(body) as string[];
      expect(command[0]).toContain("redis.call('TIME')");
      expect(command[0]).toContain("INCR");
      expect(command[0]).toContain("EXPIRE");
      expect(command[1]).toBe("0");
      for (const pseudonym of command.slice(2)) expect(pseudonym).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(String(calls[0][1].body)).toContain("du:operator-auth:actor:v1:");
    expect(String(calls[0][1].body)).toContain("du:operator-auth:contact:v1:");
    expect(String(calls[0][1].body)).toContain("du:operator-auth:global:v1:");
    expect(String(calls[3][1].body)).toContain("du:operator-auth:session:v1:");
  });

  it("never performs network I/O for malformed raw identifiers", async () => {
    const fetchMock = vi.fn();
    const guard = createOperatorAuthAdmissionGuard(baseEnv, fetchMock as typeof fetch);
    await expect(guard.admitRequestLink({}, email)).resolves.toBe(false);
    await expect(guard.admitRequestLink(headers, " Operator@Example.test ")).resolves.toBe(false);
    await expect(guard.admitRequestLink({ "x-vercel-forwarded-for": "203.0.113.7, 1.1.1.1" }, email))
      .resolves.toBe(false);
    await expect(guard.admitReauthIssuance(headers, "not-a-uuid")).resolves.toBe(false);
    await expect(guard.admitReauthVerification(headers, "not-a-uuid")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on timeout, transport/status, oversized, malformed, and unexpected Redis results", async () => {
    const failures = [
      vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
      vi.fn().mockResolvedValue(jsonResponse({ result: 1 }, 503)),
      vi.fn().mockResolvedValue(new Response("x".repeat(4_097))),
      vi.fn().mockResolvedValue(new Response("not-json")),
      vi.fn().mockResolvedValue(jsonResponse({ result: "1" })),
      vi.fn().mockResolvedValue(jsonResponse({ result: 1, extra: true })),
    ];
    for (const fetchMock of failures) {
      const guard = createOperatorAuthAdmissionGuard(baseEnv, fetchMock as typeof fetch, 5);
      await expect(guard.admitSmsVerification(headers)).resolves.toBe(false);
    }
  });

  it("rejects missing operator secret, student-secret fallback, non-Vercel, and unsafe Upstash config", () => {
    for (const env of [
      { ...baseEnv, DOWNTOWN_U_OPERATOR_AUTH_SECRET: undefined, DOWNTOWN_U_AUTH_SECRET: baseEnv.DOWNTOWN_U_OPERATOR_AUTH_SECRET },
      { ...baseEnv, DOWNTOWN_U_AUTH_SECRET: baseEnv.DOWNTOWN_U_OPERATOR_AUTH_SECRET },
      { ...baseEnv, VERCEL: "0" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "http://operator-guard.upstash.io" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "https://upstash.io.evil.test" },
      { ...baseEnv, UPSTASH_REDIS_REST_URL: "https://user:pass@operator-guard.upstash.io" },
      { ...baseEnv, UPSTASH_REDIS_REST_TOKEN: "bad\r\ntoken" },
    ]) expect(() => createOperatorAuthAdmissionGuard(env)).toThrow(OperatorAuthAdmissionConfigurationError);
  });
});
