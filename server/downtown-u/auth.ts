import { createHmac, randomBytes, randomInt } from "node:crypto";

export const AUTH_VERIFIER_VERSION = 1 as const;
export const AUTH_CHALLENGE_TTL_SECONDS = 10 * 60;
export const AUTH_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const AUTH_MAX_ATTEMPTS = 5;
export const AUTH_COOLDOWN_SECONDS = 60;
export const AUTH_RATE_WINDOW_SECONDS = 60 * 60;
export const AUTH_RATE_WINDOW_LIMIT = 5;

export type AuthContactType = "email" | "phone";
export type AuthMethod = "email_magic_link" | "sms_otp";

export class AuthConfigurationError extends Error {
  constructor() { super("Downtown U authentication is not configured"); this.name = "AuthConfigurationError"; }
}

function validateSecret(secret: string | undefined): Buffer {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new AuthConfigurationError();
  }
  const decoded = Buffer.from(secret, "base64url");
  // Format cannot prove entropy. Reject canonical malformed encodings and obvious
  // repeated-byte placeholders while requiring the CSPRNG generator's wire format.
  const repeatedPattern = Array.from({ length: 16 }, (_, index) => index + 1)
    .some((period) => 32 % period === 0
      && decoded.every((byte, index) => byte === decoded[index % period]));
  if (decoded.length !== 32 || decoded.toString("base64url") !== secret || repeatedPattern) {
    throw new AuthConfigurationError();
  }
  return decoded;
}

export interface AuthCryptography {
  readonly version: typeof AUTH_VERIFIER_VERSION;
  digestChallenge(verifier: string): Buffer;
  digestSession(token: string): Buffer;
  /** Domain-separated pseudonym for deployment-wide request admission. */
  digestRequestActor(actor: string): Buffer;
}

export function createAuthCryptography(secret: string | undefined): AuthCryptography {
  const key = validateSecret(secret);
  const digest = (purpose: string, value: string): Buffer =>
    createHmac("sha256", key).update(`downtown-u-auth\0v1\0${purpose}\0`, "utf8").update(value, "utf8").digest();
  return Object.freeze({
    version: AUTH_VERIFIER_VERSION,
    digestChallenge: (value: string) => digest("challenge-verifier", value),
    digestSession: (value: string) => digest("session-bearer", value),
    digestRequestActor: (value: string) => digest("request-admission-actor", value),
  });
}

/** 256 random bits; base64url has no contact data or timestamp. */
export function generateOpaqueId(): string { return randomBytes(32).toString("base64url"); }
export function generateBearerToken(): string { return randomBytes(32).toString("base64url"); }
export function generateMagicLinkToken(): string { return randomBytes(32).toString("base64url"); }
export function generateOtp(): string { return randomInt(0, 1_000_000).toString().padStart(6, "0"); }

export function authCryptographyFromEnvironment(env: NodeJS.ProcessEnv = process.env): AuthCryptography {
  return createAuthCryptography(env.DOWNTOWN_U_AUTH_SECRET);
}
