import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export const OPERATOR_AUTH_VERIFIER_VERSION = 1 as const;
export type OperatorAuthPurpose = "sign_in" | "reauth";
export type OperatorAuthFactor = "email_magic_link" | "sms_otp";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RAW_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NORMALIZED_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class OperatorAuthConfigurationError extends Error {
  constructor() {
    super("Downtown U operator authentication is not configured");
    this.name = "OperatorAuthConfigurationError";
  }
}

function strongSecret(value: string | undefined): Buffer {
  if (!value || !RAW_VERIFIER_PATTERN.test(value)) throw new OperatorAuthConfigurationError();
  const decoded = Buffer.from(value, "base64url");
  const repeatedPattern = Array.from({ length: 16 }, (_, index) => index + 1)
    .some((period) => 32 % period === 0
      && decoded.every((byte, index) => byte === decoded[index % period]));
  if (decoded.length !== 32 || decoded.toString("base64url") !== value || repeatedPattern) {
    throw new OperatorAuthConfigurationError();
  }
  return decoded;
}

function requireUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError("Invalid operator authentication identifier");
}

function requireRawVerifier(value: string): void {
  if (!RAW_VERIFIER_PATTERN.test(value)) throw new TypeError("Invalid operator authentication verifier");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new TypeError("Invalid operator authentication verifier");
  }
}

function requireNormalizedEmail(value: string): void {
  if (value.length < 3 || value.length > 254 || value !== value.trim()
    || value !== value.toLowerCase() || !NORMALIZED_EMAIL_PATTERN.test(value)) {
    throw new TypeError("Invalid normalized operator email");
  }
}

function canonicalIp(value: string): string | undefined {
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function requireCanonicalIp(value: string): void {
  if (canonicalIp(value) !== value) throw new TypeError("Invalid canonical operator actor address");
}

export interface OperatorAuthCryptography {
  readonly version: typeof OPERATOR_AUTH_VERIFIER_VERSION;
  digestFlow(id: string, rawVerifier: string): Buffer;
  digestChallenge(id: string, purpose: OperatorAuthPurpose, factor: OperatorAuthFactor, rawVerifier: string): Buffer;
  digestSession(id: string, bearer: string): Buffer;
  digestAdmissionActor(canonicalActorIp: string): Buffer;
  digestAdmissionContact(normalizedEmail: string): Buffer;
  digestAdmissionSession(sessionId: string): Buffer;
}

export function createOperatorAuthCryptography(secret: string | undefined): OperatorAuthCryptography {
  const key = strongSecret(secret);
  const hmac = (domain: string, rawValue: string): Buffer =>
    createHmac("sha256", key).update(domain, "utf8").update(Buffer.from([0])).update(rawValue, "utf8").digest();

  return Object.freeze({
    version: OPERATOR_AUTH_VERIFIER_VERSION,
    digestFlow(id: string, rawVerifier: string): Buffer {
      requireUuid(id);
      requireRawVerifier(rawVerifier);
      return hmac(`operator-flow:v1:${id}:sign_in:flow`, rawVerifier);
    },
    digestChallenge(id: string, purpose: OperatorAuthPurpose, factor: OperatorAuthFactor, rawVerifier: string): Buffer {
      requireUuid(id);
      if (purpose !== "sign_in" && purpose !== "reauth") throw new TypeError("Invalid operator challenge purpose");
      if (factor !== "email_magic_link" && factor !== "sms_otp") throw new TypeError("Invalid operator challenge factor");
      if (purpose === "reauth" && factor !== "sms_otp") throw new TypeError("Invalid operator reauthentication factor");
      if (factor === "sms_otp") {
        if (!/^\d{6}$/.test(rawVerifier)) throw new TypeError("Invalid operator OTP");
      } else {
        requireRawVerifier(rawVerifier);
      }
      return hmac(`operator-challenge:v1:${id}:${purpose}:${factor}`, rawVerifier);
    },
    digestSession(id: string, bearer: string): Buffer {
      requireUuid(id);
      requireRawVerifier(bearer);
      return hmac(`operator-session:v1:${id}:session:bearer`, bearer);
    },
    digestAdmissionActor(actor: string): Buffer {
      requireCanonicalIp(actor);
      return hmac("operator-admission:v1:actor", actor);
    },
    digestAdmissionContact(email: string): Buffer {
      requireNormalizedEmail(email);
      return hmac("operator-admission:v1:contact", email);
    },
    digestAdmissionSession(sessionId: string): Buffer {
      requireUuid(sessionId);
      return hmac("operator-admission:v1:session", sessionId);
    },
  });
}

export interface OperatorVerifierCredential { readonly id: string; readonly rawVerifier: string }
export interface OperatorSessionCredential { readonly id: string; readonly bearer: string }

function generateVerifier(): OperatorVerifierCredential {
  return Object.freeze({ id: randomUUID(), rawVerifier: randomBytes(32).toString("base64url") });
}

export function generateOperatorFlow(): OperatorVerifierCredential {
  return generateVerifier();
}
export function generateOperatorChallenge(): OperatorVerifierCredential {
  return generateVerifier();
}
export function generateOperatorSession(): OperatorSessionCredential {
  return Object.freeze({ id: randomUUID(), bearer: randomBytes(32).toString("base64url") });
}
export function generateOperatorOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function operatorAuthCryptographyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OperatorAuthCryptography {
  if (env.DOWNTOWN_U_OPERATOR_AUTH_SECRET === env.DOWNTOWN_U_AUTH_SECRET) {
    throw new OperatorAuthConfigurationError();
  }
  return createOperatorAuthCryptography(env.DOWNTOWN_U_OPERATOR_AUTH_SECRET);
}

/** Canonicalizes a trusted network address before it enters the keyed admission domain. */
export function canonicalizeOperatorActorIp(value: string): string | undefined {
  return canonicalIp(value);
}
