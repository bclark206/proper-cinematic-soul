import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OperatorAuthConfigurationError,
  createOperatorAuthCryptography,
  generateOperatorChallenge,
  generateOperatorFlow,
  generateOperatorOtp,
  generateOperatorSession,
  operatorAuthCryptographyFromEnvironment,
} from "../auth-crypto";

const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
  "123e4567-e89b-42d3-a456-426614174004",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const rawA = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const rawB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const rawC = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";

describe("operator authentication cryptography", () => {
  it("requires its own canonical 32-byte secret without student-secret fallback", () => {
    for (const value of [undefined, "", "short", "a".repeat(42), "a".repeat(44),
      `${secret}=`, secret.replace(/.$/, "+")]) {
      expect(() => createOperatorAuthCryptography(value)).toThrow(OperatorAuthConfigurationError);
    }
    expect(() => createOperatorAuthCryptography(secret)).not.toThrow();
    expect(() => operatorAuthCryptographyFromEnvironment({ DOWNTOWN_U_AUTH_SECRET: secret }))
      .toThrow(OperatorAuthConfigurationError);
    expect(() => operatorAuthCryptographyFromEnvironment({
      DOWNTOWN_U_OPERATOR_AUTH_SECRET: secret,
      DOWNTOWN_U_AUTH_SECRET: secret,
    })).toThrow(OperatorAuthConfigurationError);
  });

  it("matches fixed HMAC-SHA256 domain-NUL-value vectors", () => {
    const crypto = createOperatorAuthCryptography(secret);
    expect(crypto.version).toBe(1);
    expect(crypto.digestFlow(ids[0], rawA).toString("hex"))
      .toBe("c7c0a0a29ce737e80e348fb52860b170cbe9905a6d1ed1f4b51d2f366c1fb38b");
    expect(crypto.digestChallenge(ids[1], "sign_in", "email_magic_link", rawB).toString("hex"))
      .toBe("2a770c1ef5103f46e69cfee82285339256b789725cc81f49b5b3a6c9d2aabff4");
    expect(crypto.digestChallenge(ids[2], "reauth", "sms_otp", "012345").toString("hex"))
      .toBe("124e5e834a37c05d7c228a3794148ad122a21c0e2e2b03b1447a8624ea516ed8");
    expect(crypto.digestSession(ids[3], rawC).toString("hex"))
      .toBe("11bc2a45a023f627446ed8461c788677198a072d58dfa900e8baff0ba9f97869");
    expect(crypto.digestAdmissionActor("2001:db8::1").toString("hex"))
      .toBe("13e5a0666ce2e3add85f3e6e0b3d6e00f545fada93c16f603148cdde683e74a7");
    expect(crypto.digestAdmissionContact("operator@example.test").toString("hex"))
      .toBe("c20ff5169a94c56bbb4d074eb75f3e94c64825c7b1fe3f488ff6dc9ff0e931c8");
    expect(crypto.digestAdmissionSession(ids[4]).toString("hex"))
      .toBe("8ddf12a71187b5e81f71113660165b689abc7dd9e3f3c764e1c7f109d94ccb0b");
  });

  it("separates IDs, purpose, factor, and every fixed domain and exposes no generic digest", () => {
    const crypto = createOperatorAuthCryptography(secret);
    const values = [
      crypto.digestFlow(ids[0], rawA), crypto.digestFlow(ids[1], rawA),
      crypto.digestChallenge(ids[0], "sign_in", "email_magic_link", rawA),
      crypto.digestChallenge(ids[0], "sign_in", "sms_otp", "123456"),
      crypto.digestChallenge(ids[0], "reauth", "sms_otp", "123456"),
      crypto.digestSession(ids[0], rawA), crypto.digestAdmissionActor("203.0.113.7"),
      crypto.digestAdmissionContact("operator@example.test"), crypto.digestAdmissionSession(ids[0]),
      crypto.digestReadCursor("operator@example.test"),
    ].map((value) => value.toString("hex"));
    expect(new Set(values).size).toBe(values.length);
    expect(Object.keys(crypto)).not.toContain("digest");
    expect(crypto.digestFlow(ids[0], rawA)).not.toEqual(createHash("sha256").update(rawA).digest());
    expect(crypto.digestFlow(ids[0], rawA)).toHaveLength(32);
    expect(crypto.digestReadCursor("operator@example.test"))
      .not.toEqual(crypto.digestAdmissionContact("operator@example.test"));
  });

  it("rejects malformed UUID, purpose, factor, verifier, OTP, and admission identifiers", () => {
    const crypto = createOperatorAuthCryptography(secret);
    const failures = [
      () => crypto.digestFlow("not-a-uuid", rawA),
      () => crypto.digestFlow(ids[0].toUpperCase(), rawA),
      () => crypto.digestFlow(ids[0], `${rawA}=`),
      () => crypto.digestChallenge(ids[0], "other" as "sign_in", "email_magic_link", rawA),
      () => crypto.digestChallenge(ids[0], "sign_in", "email" as "email_magic_link", rawA),
      () => crypto.digestChallenge(ids[0], "sign_in", "sms_otp", "12345"),
      () => crypto.digestChallenge(ids[0], "reauth", "email_magic_link", rawA),
      () => crypto.digestSession(ids[0], "not-base64url"),
      () => crypto.digestAdmissionActor("2001:0DB8::1"),
      () => crypto.digestAdmissionActor("203.0.113.999"),
      () => crypto.digestAdmissionContact(" Operator@Example.test "),
      () => crypto.digestAdmissionSession("not-a-uuid"),
      () => crypto.digestReadCursor("é"),
      () => crypto.digestReadCursor("x"),
    ];
    for (const failure of failures) expect(failure).toThrow(TypeError);
  });

  it("generates independent UUID plus 32-byte verifier/bearer and CSPRNG six-digit OTP", () => {
    const flow = generateOperatorFlow();
    const challenge = generateOperatorChallenge();
    const session = generateOperatorSession();
    for (const id of [flow.id, challenge.id, session.id]) expect(id).toMatch(UUID_PATTERN);
    for (const raw of [flow.rawVerifier, challenge.rawVerifier, session.bearer]) {
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    }
    expect(new Set([flow.id, challenge.id, session.id]).size).toBe(3);
    expect(new Set([flow.rawVerifier, challenge.rawVerifier, session.bearer]).size).toBe(3);
    for (let index = 0; index < 64; index++) expect(generateOperatorOtp()).toMatch(/^\d{6}$/);
  });
});
