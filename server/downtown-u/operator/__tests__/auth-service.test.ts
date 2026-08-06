import { describe, expect, it, vi } from "vitest";
import { createOperatorAuthCryptography } from "../auth-crypto";
import {
  OPERATOR_AUTH_REQUEST_ACCEPTED,
  OperatorAuthService,
  type OperatorAuthDelivery,
  type OperatorAuthStore,
  type OperatorAuthStoreInputs,
} from "../auth-service";

const headers = { "x-vercel-forwarded-for": "203.0.113.4" };
const email = "operator@example.test";
const phone = "+14155550123";
const now = new Date("2026-08-05T12:00:00.000Z");
const later = new Date("2026-08-05T20:00:00.000Z");
const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64url");
const crypto = createOperatorAuthCryptography(secret);

type Method = keyof OperatorAuthStore;
type LooseStoreOverrides = Partial<Record<keyof OperatorAuthStore, ReturnType<typeof vi.fn>>>;
function store(overrides: LooseStoreOverrides = {}): OperatorAuthStore {
  const defaults = {
    begin: vi.fn(async () => ({ outcome: "accepted" as const })),
    verifyEmail: vi.fn(async () => ({ outcome: "invalid" as const })),
    finishSignIn: vi.fn(async () => ({ outcome: "invalid" as const })),
    validateSession: vi.fn(async () => ({ outcome: "invalid" as const })),
    beginReauth: vi.fn(async () => ({ outcome: "invalid" as const })),
    finishReauth: vi.fn(async () => ({ outcome: "invalid" as const })),
    revoke: vi.fn(async () => ({ outcome: "accepted" as const })),
  };
  return { ...defaults, ...overrides } as OperatorAuthStore;
}
function admission(allowed = true) {
  return {
    admitRequestLink: vi.fn(async () => allowed), admitEmailVerification: vi.fn(async () => allowed),
    admitSmsVerification: vi.fn(async () => allowed), admitReauthIssuance: vi.fn(async () => allowed),
    admitReauthVerification: vi.fn(async () => allowed),
  };
}
function setup(s = store(), allowed = true) {
  const delivery: OperatorAuthDelivery = { sendMagicLink: vi.fn(async () => undefined), sendSmsOtp: vi.fn(async () => undefined) };
  const guard = admission(allowed); const tracked: Promise<unknown>[] = [];
  return {
    service: new OperatorAuthService({ store: s, cryptography: crypto, admission: guard, delivery,
      publicOrigin: "https://operator.example.test", waitUntil: (promise) => { tracked.push(promise); }, clock: () => new Date(now) }),
    store: s, guard, delivery, tracked,
  };
}
function arg(mock: unknown, method: Method, index = 0): OperatorAuthStoreInputs[Method] {
  return (mock as ReturnType<typeof vi.fn>).mock.calls[index][0] as OperatorAuthStoreInputs[Method];
}
const flowId = "123e4567-e89b-42d3-a456-426614174000";
const challengeId = "223e4567-e89b-42d3-a456-426614174000";
const sessionId = "323e4567-e89b-42d3-a456-426614174000";
const verifier = Buffer.alloc(32, 0x11).toString("base64url");
const emailVerifier = Buffer.alloc(32, 0x22).toString("base64url");
const otp = "123456";
const bearer = Buffer.alloc(32, 0x33).toString("base64url");
const credential = { sessionId, bearer };

function expectVersionedDigests(input: Record<string, unknown>, names: string[]) {
  const versions = Object.entries(input).filter(([name]) => name === "version" || name.endsWith("Version"));
  expect(versions.length).toBeGreaterThan(0);
  for (const [, version] of versions) expect(version).toBe(1);
  for (const name of names) { expect(Buffer.isBuffer(input[name])).toBe(true); expect((input[name] as Buffer)).toHaveLength(32); }
}

describe("operator auth request-link orchestration", () => {
  it("admits first, persists independent domain-separated credentials, then tracks delivery after commit", async () => {
    const events: string[] = [];
    const s = store({ begin: vi.fn(async (input) => { events.push("store"); return { outcome: "accepted", emailChallengeId: input.emailChallengeId, expiresAt: later }; }) });
    const x = setup(s); (x.guard.admitRequestLink as ReturnType<typeof vi.fn>).mockImplementation(async () => { events.push("admission"); return true; });
    (x.delivery.sendMagicLink as ReturnType<typeof vi.fn>).mockImplementation(async () => { events.push("delivery"); });
    expect(await x.service.requestLink(email, headers)).toBe(OPERATOR_AUTH_REQUEST_ACCEPTED);
    expect(events.slice(0, 2)).toEqual(["admission", "store"]); expect(x.tracked).toHaveLength(1);
    await Promise.all(x.tracked); expect(events).toEqual(["admission", "store", "delivery"]);
    const input = arg(s.begin, "begin") as OperatorAuthStoreInputs["begin"];
    expectVersionedDigests(input as unknown as Record<string, unknown>, ["flowDigest", "emailChallengeDigest"]);
    expect(input.flowId).not.toBe(input.emailChallengeId); expect(input.correlationId).toMatch(/^operator-auth:[0-9a-f-]{36}$/);
    const sent = (x.delivery.sendMagicLink as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.flowId).toBe(input.flowId); expect(sent.challengeId).toBe(input.emailChallengeId);
    expect(input.flowDigest).toEqual(crypto.digestFlow(sent.flowId, sent.flowVerifier));
    expect(input.emailChallengeDigest).toEqual(crypto.digestChallenge(sent.challengeId, "sign_in", "email_magic_link", sent.challengeVerifier));
    expect(JSON.stringify(input)).not.toContain(sent.flowVerifier); expect(JSON.stringify(input)).not.toContain(sent.challengeVerifier);
  });

  it("returns one frozen constant and never delivers for admission, config, store, or unknown-account outcomes", async () => {
    const cases: Array<[boolean, OperatorAuthStore]> = [
      [false, store()], [true, store({ begin: vi.fn(async () => { throw new Error(`db ${email} ${verifier}`); }) })],
      [true, store({ begin: vi.fn(async () => ({ outcome: "accepted" })) })],
    ];
    for (const [allowed, s] of cases) {
      const x = setup(s, allowed); const result = await x.service.requestLink(email, headers);
      expect(result).toBe(OPERATOR_AUTH_REQUEST_ACCEPTED); expect(Object.isFrozen(result)).toBe(true);
      expect(x.delivery.sendMagicLink).not.toHaveBeenCalled(); expect(x.tracked).toHaveLength(0);
    }

    const committed = store({ begin: vi.fn(async (input) => ({ outcome: "accepted", emailChallengeId: input.emailChallengeId, expiresAt: later })) });
    const providerFailure = setup(committed);
    (providerFailure.delivery.sendMagicLink as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`${email} ${verifier}`));
    expect(await providerFailure.service.requestLink(email, headers)).toBe(OPERATOR_AUTH_REQUEST_ACCEPTED);
    expect(providerFailure.tracked).toHaveLength(1);
    await expect(Promise.all(providerFailure.tracked)).resolves.toEqual([undefined]);
  });
});

describe("operator email and SMS verification", () => {
  it("commits a fresh SMS digest before tracked delivery and exposes only its challenge id", async () => {
    let created = "";
    const s = store({ verifyEmail: vi.fn(async (input) => { created = input.smsChallengeId; return { outcome: "verified", smsChallengeId: input.smsChallengeId, normalizedPhone: phone, expiresAt: later }; }) });
    const x = setup(s); const result = await x.service.verifyEmail({ flowId, flowVerifier: verifier, challengeId, verifier: emailVerifier }, headers);
    expect(result).toEqual({ mfaRequired: true, smsChallengeId: created }); expect(Object.isFrozen(result)).toBe(true); expect(x.tracked).toHaveLength(1);
    const input = arg(s.verifyEmail, "verifyEmail") as OperatorAuthStoreInputs["verifyEmail"];
    expectVersionedDigests(input as unknown as Record<string, unknown>, ["flowDigest", "emailChallengeDigest", "smsChallengeDigest"]);
    expect(input.flowDigest).toEqual(crypto.digestFlow(flowId, verifier));
    expect(input.emailChallengeDigest).toEqual(crypto.digestChallenge(challengeId, "sign_in", "email_magic_link", emailVerifier));
    await Promise.all(x.tracked); const sent = (x.delivery.sendSmsOtp as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent).toMatchObject({ normalizedPhone: phone, purpose: "sign_in" });
    expect(input.smsChallengeDigest).toEqual(crypto.digestChallenge(created, "sign_in", "sms_otp", sent.otp));
    expect(JSON.stringify(input)).not.toContain(sent.otp);
  });

  it("maps denied/invalid generically, store failure distinctly, and never delivers unless exact success", async () => {
    const denied = setup(store(), false); expect(await denied.service.verifyEmail({ flowId, flowVerifier: verifier, challengeId, verifier: emailVerifier }, headers)).toEqual({ authenticated: false });
    expect(denied.store.verifyEmail).not.toHaveBeenCalled();
    for (const s of [store(), store({ verifyEmail: vi.fn(async () => ({ outcome: "verified", smsChallengeId: challengeId, normalizedPhone: phone, expiresAt: later })) })]) {
      const x = setup(s); expect(await x.service.verifyEmail({ flowId, flowVerifier: verifier, challengeId, verifier: emailVerifier }, headers)).toEqual({ authenticated: false });
      expect(x.delivery.sendSmsOtp).not.toHaveBeenCalled();
    }
    const failed = setup(store({ verifyEmail: vi.fn(async () => { throw new Error(`secret ${otp}`); }) }));
    expect(await failed.service.verifyEmail({ flowId, flowVerifier: verifier, challengeId, verifier: emailVerifier }, headers)).toEqual({ unavailable: true });
    expect(JSON.stringify(await failed.service.verifyEmail({ flowId, flowVerifier: verifier, challengeId, verifier: emailVerifier }, headers))).not.toContain(otp);
  });

  it("creates a session from SMS proof and separates public identity from the cookie credential", async () => {
    let generatedSession = "";
    const s = store({ finishSignIn: vi.fn(async (input) => { generatedSession = input.sessionId; return { outcome: "authenticated", sessionId: input.sessionId,
      operatorId: "423e4567-e89b-42d3-a456-426614174000", displayName: "Operator One", roleCodes: ["reconciliation_operator", "audit_exporter"], absoluteExpiresAt: later, idleExpiresAt: later }; }) });
    const x = setup(s); const result = await x.service.verifySms({ flowId, flowVerifier: verifier, challengeId, otp }, headers);
    expect(result).toMatchObject({ public: { authenticated: true, displayName: "Operator One", roles: ["audit_exporter", "reconciliation_operator"] }, cookie: { sessionId: generatedSession, absoluteExpiresAt: later } });
    if (!("public" in result)) throw new Error("expected authenticated result");
    expect(JSON.stringify(result.public)).not.toContain("423e4567"); expect("bearer" in result.public).toBe(false);
    expect(JSON.stringify(result)).toBe('{"public":{"authenticated":true,"displayName":"Operator One","roles":["audit_exporter","reconciliation_operator"]}}');
    const input = arg(s.finishSignIn, "finishSignIn") as OperatorAuthStoreInputs["finishSignIn"];
    expectVersionedDigests(input as unknown as Record<string, unknown>, ["flowDigest", "smsChallengeDigest", "sessionDigest"]);
    expect(input.smsChallengeDigest).toEqual(crypto.digestChallenge(challengeId, "sign_in", "sms_otp", otp));
    expect(input.sessionDigest).toEqual(crypto.digestSession(result.cookie.sessionId, result.cookie.bearer));
    expect(JSON.stringify(input)).not.toContain(result.cookie.bearer); expect(Object.isFrozen(result.public.roles)).toBe(true);
  });

  it("fails closed when a committed session cannot back at least one whole cookie second", async () => {
    const deadlines = [
      [now, later],
      [new Date(now.getTime() - 1), later],
      [new Date(now.getTime() + 999), later],
      [later, now],
      [later, new Date(now.getTime() - 1)],
      [later, new Date(now.getTime() + 999)],
      [new Date(now.getTime() + 2_000), new Date(now.getTime() + 2_001)],
    ] as const;
    for (const [absoluteExpiresAt, idleExpiresAt] of deadlines) {
      const s = store({ finishSignIn: vi.fn(async (input) => ({
        outcome: "authenticated" as const, sessionId: input.sessionId,
        operatorId: "423e4567-e89b-42d3-a456-426614174000", displayName: "Operator One",
        roleCodes: ["admin"], absoluteExpiresAt, idleExpiresAt,
      })) });
      const result = await setup(s).service.verifySms({ flowId, flowVerifier: verifier, challengeId, otp }, headers);
      expect(result).toEqual({ authenticated: false });
      expect("cookie" in result).toBe(false);
    }
  });

  it("maps replay/invalid and failures without returning generated credentials", async () => {
    const invalid = setup(); expect(await invalid.service.verifySms({ flowId, flowVerifier: verifier, challengeId, otp }, headers)).toEqual({ authenticated: false });
    const failed = setup(store({ finishSignIn: vi.fn(async () => { throw new Error(bearer); }) }));
    expect(await failed.service.verifySms({ flowId, flowVerifier: verifier, challengeId, otp }, headers)).toEqual({ unavailable: true });
  });
});

describe("operator sessions, logout, and reauthentication", () => {
  it("validates every session call against the read gate/current roles and computes strict five-minute freshness", async () => {
    const consumed = new Date(now.getTime() - 299_999);
    const s = store({ validateSession: vi.fn(async () => ({ outcome: "authorized", operatorId: flowId, displayName: "Current Name", roleCodes: ["z_role", "a_role"], gateCode: "read", absoluteExpiresAt: later, idleExpiresAt: later, reauthenticatedAt: consumed })) });
    const x = setup(s); const one = await x.service.session(credential); const two = await x.service.session(credential);
    expect(one).toEqual({ authenticated: true, displayName: "Current Name", roles: ["a_role", "z_role"], smsReauthFresh: true }); expect(two).toEqual(one);
    expect(s.validateSession).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) { const input = arg(s.validateSession, "validateSession", i) as OperatorAuthStoreInputs["validateSession"]; expect(input.roleCode).toBeNull(); expect(input.gateCode).toBe("read"); expect(input.sessionDigest).toEqual(crypto.digestSession(sessionId, bearer)); }
    (s.validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "authorized", operatorId: flowId, displayName: "N", roleCodes: ["x"], gateCode: "read", absoluteExpiresAt: later, idleExpiresAt: later, reauthenticatedAt: new Date(now.getTime() - 300_000) });
    expect(await x.service.session(credential)).toMatchObject({ smsReauthFresh: false });
  });

  it("maps invalid and policy denial without IDs and maps store errors unavailable", async () => {
    for (const outcome of ["invalid", "denied", "reauth_required"] as const) {
      const x = setup(store({ validateSession: vi.fn(async () => ({ outcome })) }));
      const response = await x.service.session(credential); expect(response).toEqual({ authenticated: false }); expect(JSON.stringify(response)).not.toContain(sessionId);
    }
    const x = setup(store({ validateSession: vi.fn(async () => { throw new Error(sessionId); }) })); expect(await x.service.session(credential)).toEqual({ unavailable: true });
  });

  it("revokes directly without admission/gates and returns typed success/unavailable", async () => {
    const x = setup(); expect(await x.service.logout(credential)).toEqual({ success: true }); expect(x.store.validateSession).not.toHaveBeenCalled();
    const input = arg(x.store.revoke, "revoke") as OperatorAuthStoreInputs["revoke"]; expect(input.sessionDigest).toEqual(crypto.digestSession(sessionId, bearer));
    const failed = setup(store({ revoke: vi.fn(async () => { throw new Error(bearer); }) })); expect(await failed.service.logout(credential)).toEqual({ unavailable: true });
    expect(await x.service.logout(null)).toEqual({ success: true });
  });

  it("issues reauth only after admission and exact committed success, with no delivery-status leak", async () => {
    let generated = "";
    const s = store({ beginReauth: vi.fn(async (input) => { generated = input.challengeId; return { outcome: "started", challengeId: input.challengeId, normalizedPhone: phone, expiresAt: later }; }) });
    const x = setup(s); const response = await x.service.requestReauth(credential, headers);
    expect(response).toEqual({ accepted: true, challengeId: generated });
    expect(Object.keys(response)).toEqual(["accepted", "challengeId"]);
    expect(Object.isFrozen(response)).toBe(true);
    expect(x.guard.admitReauthIssuance).toHaveBeenCalledWith(headers, sessionId); expect(x.tracked).toHaveLength(1);
    await Promise.all(x.tracked); const sent = (x.delivery.sendSmsOtp as ReturnType<typeof vi.fn>).mock.calls[0][0]; expect(sent.purpose).toBe("reauth");
    const input = arg(s.beginReauth, "beginReauth") as OperatorAuthStoreInputs["beginReauth"];
    expect(input.challengeDigest).toEqual(crypto.digestChallenge(generated, "reauth", "sms_otp", sent.otp)); expect(JSON.stringify(response)).not.toContain(phone);

    const rejectingStore = store({ beginReauth: vi.fn(async (item) => ({ outcome: "started", challengeId: item.challengeId, normalizedPhone: phone, expiresAt: later })) });
    const rejecting = setup(rejectingStore);
    (rejecting.delivery.sendSmsOtp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`${phone} ${otp}`));
    const rejectingResponse = await rejecting.service.requestReauth(credential, headers);
    const rejectingInput = arg(rejectingStore.beginReauth, "beginReauth") as OperatorAuthStoreInputs["beginReauth"];
    expect(rejectingResponse).toEqual({ accepted: true, challengeId: rejectingInput.challengeId });
    await expect(Promise.all(rejecting.tracked)).resolves.toEqual([undefined]);
  });

  it("returns request-link's exact frozen accepted-only contract unchanged", async () => {
    const s = store({ begin: vi.fn(async (input) => ({ outcome: "accepted", emailChallengeId: input.emailChallengeId, expiresAt: later })) });
    const result = await setup(s).service.requestLink(email, headers);
    expect(result).toBe(OPERATOR_AUTH_REQUEST_ACCEPTED);
    expect(Object.keys(result)).toEqual(["accepted"]);
    expect(JSON.stringify(result)).toBe('{"accepted":true}');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails closed on mismatched, non-canonical, extra, accessor, and proxy reauth store successes", async () => {
    let getterCalls = 0;
    const proxyTraps = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
    let dateGetCalls = 0;
    const traps: ProxyHandler<object> = {
      getPrototypeOf: () => { proxyTraps.getPrototypeOf += 1; throw new Error("hostile getPrototypeOf"); },
      ownKeys: () => { proxyTraps.ownKeys += 1; throw new Error("hostile ownKeys"); },
      getOwnPropertyDescriptor: () => {
        proxyTraps.getOwnPropertyDescriptor += 1;
        throw new Error("hostile getOwnPropertyDescriptor");
      },
    };
    const cases: OperatorAuthStore[] = [
      store({ beginReauth: vi.fn(async () => ({ outcome: "started", challengeId: flowId, normalizedPhone: phone, expiresAt: later })) }),
      store({ beginReauth: vi.fn(async (input) => ({ outcome: "started", challengeId: input.challengeId.toUpperCase(), normalizedPhone: phone, expiresAt: later })) }),
      store({ beginReauth: vi.fn(async (input) => ({ outcome: "started", challengeId: input.challengeId, normalizedPhone: phone, expiresAt: later, operatorId: flowId })) }),
      store({ beginReauth: vi.fn(async (input) => {
        const result = { outcome: "started", challengeId: input.challengeId, normalizedPhone: phone, expiresAt: later } as Record<string, unknown>;
        Object.defineProperty(result, "challengeId", { enumerable: true, get: () => { getterCalls += 1; return input.challengeId; } });
        return result;
      }) }),
      store({ beginReauth: vi.fn(async (input) => new Proxy(
        { outcome: "started", challengeId: input.challengeId, normalizedPhone: phone, expiresAt: later }, traps,
      )) }),
      store({ beginReauth: vi.fn(async (input) => ({
        outcome: "started", challengeId: input.challengeId, normalizedPhone: phone,
        expiresAt: new Proxy(new Date(later), {
          ...traps,
          get: () => { dateGetCalls += 1; throw new Error("hostile Date get"); },
        }),
      })) }),
    ];
    for (const item of cases) {
      const x = setup(item);
      const response = await x.service.requestReauth(credential, headers);
      expect(response).toEqual({ authenticated: false });
      expect(JSON.stringify(response)).not.toMatch(/phone|otp|operatorId|expiresAt/);
      expect(x.delivery.sendSmsOtp).not.toHaveBeenCalled();
      expect(x.tracked).toHaveLength(0);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    expect(dateGetCalls).toBe(0);
  });

  it("maps invalid issuance generically and store outage distinctly", async () => {
    const denied = setup(store(), false); expect(await denied.service.requestReauth(credential, headers)).toEqual({ authenticated: false }); expect(denied.store.beginReauth).not.toHaveBeenCalled();
    expect(await setup().service.requestReauth(credential, headers)).toEqual({ authenticated: false });
    const failed = setup(store({ beginReauth: vi.fn(async () => { throw new Error(phone); }) })); expect(await failed.service.requestReauth(credential, headers)).toEqual({ unavailable: true });
  });

  it("finishes session-bound reauth and exposes a fixed five-minute validity only on exact success", async () => {
    const s = store({ finishReauth: vi.fn(async () => ({ outcome: "reauthenticated", reauthenticatedAt: now })) }); const x = setup(s);
    expect(await x.service.verifyReauth(credential, { challengeId, otp }, headers)).toEqual({ reauthenticated: true, validForSeconds: 300 });
    expect(x.guard.admitReauthVerification).toHaveBeenCalledWith(headers, sessionId);
    const input = arg(s.finishReauth, "finishReauth") as OperatorAuthStoreInputs["finishReauth"];
    expect(input.challengeDigest).toEqual(crypto.digestChallenge(challengeId, "reauth", "sms_otp", otp)); expect(JSON.stringify(input)).not.toContain(otp);
    const invalid = setup(); expect(await invalid.service.verifyReauth(credential, { challengeId, otp }, headers)).toEqual({ reauthenticated: false });
    const failed = setup(store({ finishReauth: vi.fn(async () => { throw new Error(otp); }) })); expect(await failed.service.verifyReauth(credential, { challengeId, otp }, headers)).toEqual({ unavailable: true });
  });
});
