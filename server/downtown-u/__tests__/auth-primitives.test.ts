import { describe, expect, it } from "vitest";
import {
  AUTH_CHALLENGE_TTL_SECONDS,
  AuthConfigurationError,
  createAuthCryptography,
  generateBearerToken,
  generateMagicLinkToken,
  generateOtp,
  generateOpaqueId,
} from "../auth";

describe("Downtown U auth cryptography", () => {
  it("rejects every non-canonical secret format", () => {
    for (const secret of [
      undefined, "short", "a".repeat(43), "A".repeat(43), "0123456789abcdef".repeat(4),
      Buffer.from("0123456789abcdef".repeat(2)).toString("base64url"), // encoded repeated placeholder
      "cGhhc2UzYS1hdXRoLXRlc3Qta2V5LW1hdGVyaWFsLTA=", // padding
      "cGhhc2UzYS1hdXRoLXRlc3Qta2V5LW1hdGVyaWFsL+0", // alphabet
      "cGhhc2UzYS1hdXRoLXRlc3Qta2V5LW1hdGVyaWFsLT", // decoded length
    ]) expect(() => createAuthCryptography(secret)).toThrow(AuthConfigurationError);
  });

  it("accepts canonical unpadded base64url encoding of exactly 32 bytes", () => {
    const value = Buffer.from(Array.from({length:32}, (_, index) => index)).toString("base64url");
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => createAuthCryptography(value)).not.toThrow();
  });

  it("is deterministic and domain separates challenge and session verifiers", () => {
    const crypto = createAuthCryptography("cGhhc2UzYS1hdXRoLXRlc3Qta2V5LW1hdGVyaWFsLTA");
    expect(crypto.version).toBe(1);
    expect(crypto.digestChallenge("same")).toEqual(crypto.digestChallenge("same"));
    expect(crypto.digestChallenge("same")).not.toEqual(crypto.digestSession("same"));
    expect(crypto.digestChallenge("different")).not.toEqual(crypto.digestChallenge("same"));
    expect(crypto.digestChallenge("same")).toHaveLength(32);
  });

  it("generates bounded base64url identifiers, bearer tokens, and six-digit OTPs", () => {
    for (const generator of [generateOpaqueId, generateBearerToken, generateMagicLinkToken]) {
      const values = new Set(Array.from({ length: 128 }, generator));
      expect(values.size).toBe(128);
      for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    const otps = new Set(Array.from({ length: 128 }, generateOtp));
    expect(otps.size).toBeGreaterThan(1);
    for (const otp of otps) expect(otp).toMatch(/^\d{6}$/);
    expect(AUTH_CHALLENGE_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
