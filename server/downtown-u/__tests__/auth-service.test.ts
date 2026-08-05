import { describe, expect, it, vi } from "vitest";
import { createAuthCryptography } from "../auth";
import {
  AUTH_REQUEST_ACCEPTED, DowntownUAuthService, type AuthDeliverySink, type PendingAuthDelivery,
} from "../auth-service";
import type {
  AuthStore, ConsumeChallengeCommand, CreateChallengeCommand, SessionCredential,
} from "../postgres-auth-store";

const crypto = createAuthCryptography("cGhhc2UzYS1hdXRoLXRlc3Qta2V5LW1hdGVyaWFsLTA");
const expiry = new Date("2026-08-06T00:00:00.000Z");

function fakeStore(overrides: Partial<AuthStore> = {}): AuthStore {
  return {
    createChallenge: vi.fn<AuthStore["createChallenge"]>(async (command: CreateChallengeCommand) => ({
      outcome: "accepted" as const, challengeId: command.challengeId, expiresAt: expiry,
    })),
    consumeChallenge: vi.fn<AuthStore["consumeChallenge"]>(async (_command: ConsumeChallengeCommand) => ({ outcome: "invalid" as const })),
    validateSession: vi.fn<AuthStore["validateSession"]>(async (_credential: SessionCredential) => ({ outcome: "invalid" as const })),
    revokeSession: vi.fn<AuthStore["revokeSession"]>(async (_credential: SessionCredential) => ({ outcome: "accepted" as const })),
    ...overrides,
  };
}

function serialized(value: unknown): string { return JSON.stringify(value); }

describe("Downtown U authentication service boundary", () => {
  it.each([
    ["email", "  PERSON@Example.COM ", "person@example.com", "email_magic_link"],
    ["phone", "(415) 555-0123", "+14155550123", "sms_otp"],
  ] as const)("delivers %s material internally while returning only the constant response", async (
    contactType, input, normalizedContact, method,
  ) => {
    const store = fakeStore();
    const deliveries: PendingAuthDelivery[] = [];
    const sink: AuthDeliverySink = { deliver: vi.fn(async (delivery) => { deliveries.push(delivery); }) };
    const response = await new DowntownUAuthService(store, crypto, sink).request(contactType, input);

    expect(response).toBe(AUTH_REQUEST_ACCEPTED);
    expect(serialized(response)).toBe('{"accepted":true}');
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(deliveries[0]).toMatchObject({ method, normalizedContact, expiresAt: expiry });
    expect(store.createChallenge).toHaveBeenCalledOnce();
    const command = vi.mocked(store.createChallenge).mock.calls[0][0];
    expect(command).toMatchObject({ contactType, normalizedContact, method });
    expect(command.digest).toEqual(crypto.digestChallenge(deliveries[0].verifier));
    expect(command).not.toHaveProperty("verifier");
    for (const secret of [deliveries[0].verifier, deliveries[0].normalizedContact, deliveries[0].challengeId]) {
      expect(serialized(response)).not.toContain(secret);
    }
  });

  it.each([
    ["malformed email", "email", "not-an-email"],
    ["malformed phone", "phone", "123"],
    ["malformed type", "fax", "person@example.com"],
  ] as const)("returns exactly the constant response for %s without storage or delivery", async (_name, type, contact) => {
    const store = fakeStore(); const sink = { deliver: vi.fn(async () => undefined) };
    const response = await new DowntownUAuthService(store, crypto, sink).request(type as "email", contact);
    expect(serialized(response)).toBe('{"accepted":true}');
    expect(store.createChallenge).not.toHaveBeenCalled(); expect(sink.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ["known or unknown/rate-limited", async () => ({ outcome: "accepted" as const })],
    ["known conflict", async () => { throw Object.assign(new Error("conflict"), { code: "23505" }); }],
    ["unknown store failure", async () => { throw new Error("database detail"); }],
  ] as const)("returns exactly the constant response for %s", async (_name, createChallenge) => {
    const observer = vi.fn(); const sink = { deliver: vi.fn(async () => undefined) };
    const response = await new DowntownUAuthService(fakeStore({ createChallenge }), crypto, sink, observer)
      .request("email", "person@example.com");
    expect(serialized(response)).toBe('{"accepted":true}');
    expect(sink.deliver).not.toHaveBeenCalled();
  });

  it("swallows delivery and observer failures without changing or leaking the response", async () => {
    let delivered: PendingAuthDelivery | undefined;
    const sink = { deliver: vi.fn(async (value: PendingAuthDelivery) => { delivered=value; throw new Error("provider detail"); }) };
    const response = await new DowntownUAuthService(fakeStore(), crypto, sink, async () => {
      throw new Error("observer");
    })
      .request("email", "known@example.com");
    expect(serialized(response)).toBe('{"accepted":true}');
    expect(delivered).toMatchObject({ normalizedContact:"known@example.com", method:"email_magic_link" });
    expect(serialized(response)).not.toContain(delivered!.verifier);
    expect(serialized(response)).not.toContain(delivered!.normalizedContact);
    expect(serialized(response)).not.toContain(delivered!.challengeId);
  });

  it("keeps the request response frozen and invariant", () => {
    expect(AUTH_REQUEST_ACCEPTED).toEqual({ accepted: true });
    expect(Object.isFrozen(AUTH_REQUEST_ACCEPTED)).toBe(true);
    expect(Object.keys(AUTH_REQUEST_ACCEPTED)).toEqual(["accepted"]);
  });

  it("generates opaque session credentials and passes only their digests to storage", async () => {
    let captured!: ConsumeChallengeCommand;
    const store = fakeStore({ consumeChallenge: vi.fn<AuthStore["consumeChallenge"]>(async (command) => {
      captured = command;
      return { outcome: "authenticated" as const, sessionId: command.sessionId, studentId: "student", expiresAt: expiry };
    }) });
    const result = await new DowntownUAuthService(store, crypto).verify("C".repeat(43), "magic-secret");
    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") throw new Error("expected authentication");
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(captured.sessionId).toBe(result.sessionId);
    expect(captured.sessionDigest).toEqual(crypto.digestSession(result.bearerToken));
    expect(captured).not.toHaveProperty("bearerToken");
    expect(captured.digest).toEqual(crypto.digestChallenge("magic-secret"));
    expect(captured).not.toHaveProperty("verifier");
  });

  it("never exposes generated session credentials when verification is invalid", async () => {
    const result = await new DowntownUAuthService(fakeStore(), crypto).verify("C".repeat(43), "wrong");
    expect(result).toEqual({ outcome: "invalid" });
    expect(result).not.toHaveProperty("bearerToken"); expect(result).not.toHaveProperty("sessionId");
  });

  it("domain-hashes bearer credentials for validation and revocation", async () => {
    const store = fakeStore(); const service = new DowntownUAuthService(store, crypto);
    await service.validate("session-id", "bearer-secret"); await service.revoke("session-id", "bearer-secret");
    const expected = { sessionId: "session-id", digest: crypto.digestSession("bearer-secret") };
    expect(store.validateSession).toHaveBeenCalledWith(expected); expect(store.revokeSession).toHaveBeenCalledWith(expected);
    expect(vi.mocked(store.validateSession).mock.calls[0][0]).not.toHaveProperty("bearerToken");
  });
});
