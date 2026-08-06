import { randomUUID } from "node:crypto";
import type { OperatorAuthAdmissionGuard } from "./auth-admission";
import {
  OPERATOR_AUTH_VERIFIER_VERSION,
  generateOperatorChallenge,
  generateOperatorFlow,
  generateOperatorOtp,
  generateOperatorSession,
  type OperatorAuthCryptography,
  type OperatorSessionCredential as GeneratedSessionCredential,
  type OperatorVerifierCredential,
} from "./auth-crypto";
import type { SendOperatorMagicLinkInput, SendOperatorSmsOtpInput } from "./auth-delivery";

export type OperatorAuthHeaders = Record<string, string | string[] | undefined>;
export interface OperatorSessionCredential { readonly sessionId: string; readonly bearer: string }

interface Correlated { readonly correlationId: string }
interface VersionedSession extends Correlated {
  readonly sessionId: string;
  readonly sessionVersion: 1;
  readonly sessionDigest: Buffer;
}

export interface OperatorAuthBeginInput extends Correlated {
  readonly flowId: string;
  readonly normalizedEmail: string;
  readonly version: 1;
  readonly flowDigest: Buffer;
  readonly emailChallengeId: string;
  readonly emailChallengeDigest: Buffer;
}
export type OperatorAuthBeginResult =
  | Readonly<{ outcome: "accepted" }>
  | Readonly<{ outcome: "accepted"; emailChallengeId: string; expiresAt: Date }>;

export interface OperatorAuthVerifyEmailInput extends Correlated {
  readonly flowId: string;
  readonly flowVersion: 1;
  readonly flowDigest: Buffer;
  readonly emailChallengeId: string;
  readonly emailChallengeVersion: 1;
  readonly emailChallengeDigest: Buffer;
  readonly smsChallengeId: string;
  readonly smsChallengeVersion: 1;
  readonly smsChallengeDigest: Buffer;
}
export type OperatorAuthVerifyEmailResult =
  | Readonly<{ outcome: "invalid" }>
  | Readonly<{ outcome: "verified"; smsChallengeId: string; normalizedPhone: string; expiresAt: Date }>;

export interface OperatorAuthFinishSignInInput extends Correlated {
  readonly flowId: string;
  readonly flowVersion: 1;
  readonly flowDigest: Buffer;
  readonly smsChallengeId: string;
  readonly smsChallengeVersion: 1;
  readonly smsChallengeDigest: Buffer;
  readonly sessionId: string;
  readonly sessionVersion: 1;
  readonly sessionDigest: Buffer;
}
export type OperatorAuthFinishSignInResult =
  | Readonly<{ outcome: "invalid" }>
  | Readonly<{ outcome: "authenticated"; sessionId: string; operatorId: string; displayName: string;
      roleCodes: readonly string[]; absoluteExpiresAt: Date; idleExpiresAt: Date }>;

export interface OperatorAuthValidateSessionInput extends VersionedSession {
  readonly roleCode: string | null;
  readonly gateCode: "read" | "mutations" | "exports";
}
export type OperatorAuthValidateSessionResult =
  | Readonly<{ outcome: "invalid" | "denied" | "reauth_required" }>
  | Readonly<{ outcome: "authorized"; operatorId: string; displayName: string; roleCodes: readonly string[];
      gateCode: "read" | "mutations" | "exports"; absoluteExpiresAt: Date; idleExpiresAt: Date;
      reauthenticatedAt: Date | null }>;

export interface OperatorAuthBeginReauthInput extends VersionedSession {
  readonly challengeId: string;
  readonly challengeVersion: 1;
  readonly challengeDigest: Buffer;
}
export type OperatorAuthBeginReauthResult =
  | Readonly<{ outcome: "invalid" | "denied" }>
  | Readonly<{ outcome: "started"; challengeId: string; normalizedPhone: string; expiresAt: Date }>;

export interface OperatorAuthFinishReauthInput extends VersionedSession {
  readonly challengeId: string;
  readonly challengeVersion: 1;
  readonly challengeDigest: Buffer;
}
export type OperatorAuthFinishReauthResult =
  | Readonly<{ outcome: "invalid" }>
  | Readonly<{ outcome: "reauthenticated"; reauthenticatedAt: Date }>;

export type OperatorAuthRevokeInput = VersionedSession;
export type OperatorAuthRevokeResult = Readonly<{ outcome: "accepted" }>;

/** The seven capability calls granted to the operator runtime role by migration 010. */
export interface OperatorAuthStore {
  begin(input: OperatorAuthBeginInput): Promise<OperatorAuthBeginResult>;
  verifyEmail(input: OperatorAuthVerifyEmailInput): Promise<OperatorAuthVerifyEmailResult>;
  finishSignIn(input: OperatorAuthFinishSignInInput): Promise<OperatorAuthFinishSignInResult>;
  validateSession(input: OperatorAuthValidateSessionInput): Promise<OperatorAuthValidateSessionResult>;
  beginReauth(input: OperatorAuthBeginReauthInput): Promise<OperatorAuthBeginReauthResult>;
  finishReauth(input: OperatorAuthFinishReauthInput): Promise<OperatorAuthFinishReauthResult>;
  revoke(input: OperatorAuthRevokeInput): Promise<OperatorAuthRevokeResult>;
}

/** Convenience map for mocks/adapters; values are the exact seven store inputs. */
export interface OperatorAuthStoreInputs {
  begin: OperatorAuthBeginInput;
  verifyEmail: OperatorAuthVerifyEmailInput;
  finishSignIn: OperatorAuthFinishSignInInput;
  validateSession: OperatorAuthValidateSessionInput;
  beginReauth: OperatorAuthBeginReauthInput;
  finishReauth: OperatorAuthFinishReauthInput;
  revoke: OperatorAuthRevokeInput;
}

/** Raw credentials cross this delivery boundary only after their DB digest commits. */
export interface OperatorAuthDelivery {
  sendMagicLink(input: SendOperatorMagicLinkInput): Promise<void>;
  sendSmsOtp(input: SendOperatorSmsOtpInput): Promise<void>;
}

export interface OperatorAuthCredentialFactory {
  readonly flow: () => OperatorVerifierCredential;
  readonly challenge: () => OperatorVerifierCredential;
  readonly otp: () => string;
  readonly session: () => GeneratedSessionCredential;
  readonly correlationId: () => string;
}

export interface OperatorAuthServiceDependencies {
  readonly store: OperatorAuthStore;
  readonly cryptography: OperatorAuthCryptography;
  readonly admission: OperatorAuthAdmissionGuard;
  readonly delivery: OperatorAuthDelivery;
  readonly publicOrigin: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly clock: () => Date;
  readonly credentials?: Partial<OperatorAuthCredentialFactory>;
}

export const OPERATOR_AUTH_REQUEST_ACCEPTED = Object.freeze({ accepted: true as const });
const UNAUTHENTICATED = Object.freeze({ authenticated: false as const });
const NOT_REAUTHENTICATED = Object.freeze({ reauthenticated: false as const });
const UNAVAILABLE = Object.freeze({ unavailable: true as const });
const LOGOUT_SUCCESS = Object.freeze({ success: true as const });

export type OperatorRequestLinkResponse = typeof OPERATOR_AUTH_REQUEST_ACCEPTED;
export type OperatorUnavailableResponse = typeof UNAVAILABLE;
export type OperatorVerifyEmailResponse =
  | Readonly<{ mfaRequired: true; smsChallengeId: string }>
  | typeof UNAUTHENTICATED | OperatorUnavailableResponse;
export type OperatorVerifySmsResponse =
  | Readonly<{ public: Readonly<{ authenticated: true; displayName: string; roles: readonly string[] }>;
      cookie: Readonly<{ sessionId: string; bearer: string; absoluteExpiresAt: Date }> }>
  | typeof UNAUTHENTICATED | OperatorUnavailableResponse;
export type OperatorSessionResponse =
  | Readonly<{ authenticated: true; displayName: string; roles: readonly string[]; smsReauthFresh: boolean }>
  | typeof UNAUTHENTICATED | OperatorUnavailableResponse;
export type OperatorLogoutResponse = typeof LOGOUT_SUCCESS | OperatorUnavailableResponse;
export type OperatorRequestReauthResponse = typeof OPERATOR_AUTH_REQUEST_ACCEPTED | typeof UNAUTHENTICATED | OperatorUnavailableResponse;
export type OperatorVerifyReauthResponse =
  | Readonly<{ reauthenticated: true; validForSeconds: 300 }>
  | typeof NOT_REAUTHENTICATED | OperatorUnavailableResponse;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_ROLES = 64;
const MAX_ROLE_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 200;

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function publicIdentity(displayName: unknown, roleCodes: unknown): { displayName: string; roles: readonly string[] } | undefined {
  if (typeof displayName !== "string" || displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME_LENGTH
      || !Array.isArray(roleCodes) || roleCodes.length < 1 || roleCodes.length > MAX_ROLES
      || roleCodes.some((role) => typeof role !== "string" || role.length < 1 || role.length > MAX_ROLE_LENGTH
        || !/^[a-z][a-z0-9_]*$/.test(role))) return undefined;
  const roles = [...new Set(roleCodes as string[])].sort();
  if (roles.length !== roleCodes.length) return undefined;
  return { displayName, roles: Object.freeze(roles) };
}
function correlationId(factory: () => string): string {
  const value = `operator-auth:${factory()}`;
  if (value.length > 127 || !/^operator-auth:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Operator authentication correlation generation failed");
  }
  return value;
}

export class OperatorAuthService {
  private readonly credentials: OperatorAuthCredentialFactory;
  constructor(private readonly dependencies: OperatorAuthServiceDependencies) {
    this.credentials = Object.freeze({
      flow: dependencies.credentials?.flow ?? generateOperatorFlow,
      challenge: dependencies.credentials?.challenge ?? generateOperatorChallenge,
      otp: dependencies.credentials?.otp ?? generateOperatorOtp,
      session: dependencies.credentials?.session ?? generateOperatorSession,
      correlationId: dependencies.credentials?.correlationId ?? randomUUID,
    });
  }

  private correlationId(): string { return correlationId(this.credentials.correlationId); }
  private sessionInput(credential: OperatorSessionCredential): VersionedSession {
    return {
      sessionId: credential.sessionId,
      sessionVersion: OPERATOR_AUTH_VERIFIER_VERSION,
      sessionDigest: this.dependencies.cryptography.digestSession(credential.sessionId, credential.bearer),
      correlationId: this.correlationId(),
    };
  }
  private track(work: () => Promise<void>): void {
    // Promise continuation guarantees provider invocation is downstream of the
    // completed store call. All provider details are collapsed before tracking.
    const tracked = Promise.resolve().then(work).catch(() => undefined);
    try { this.dependencies.waitUntil(tracked); } catch { /* Tracking cannot change an auth result. */ }
  }

  /** Enumeration-resistant: admission/configuration/store/provider outcomes have one response shape. */
  async requestLink(normalizedEmail: string, headers: OperatorAuthHeaders): Promise<OperatorRequestLinkResponse> {
    try {
      if (!await this.dependencies.admission.admitRequestLink(headers, normalizedEmail)) return OPERATOR_AUTH_REQUEST_ACCEPTED;
      const flow = this.credentials.flow();
      const challenge = this.credentials.challenge();
      const result = await this.dependencies.store.begin({
        flowId: flow.id,
        normalizedEmail,
        version: OPERATOR_AUTH_VERIFIER_VERSION,
        flowDigest: this.dependencies.cryptography.digestFlow(flow.id, flow.rawVerifier),
        emailChallengeId: challenge.id,
        emailChallengeDigest: this.dependencies.cryptography.digestChallenge(challenge.id, "sign_in", "email_magic_link", challenge.rawVerifier),
        correlationId: this.correlationId(),
      });
      if (result.outcome === "accepted" && "emailChallengeId" in result
          && result.emailChallengeId === challenge.id && validDate(result.expiresAt)) {
        const delivery = Object.freeze({ normalizedEmail, publicOrigin: this.dependencies.publicOrigin,
          flowId: flow.id, flowVerifier: flow.rawVerifier, challengeId: challenge.id,
          challengeVerifier: challenge.rawVerifier });
        this.track(() => this.dependencies.delivery.sendMagicLink(delivery));
      }
    } catch { /* Deliberately indistinguishable from accepted unknown contact. */ }
    return OPERATOR_AUTH_REQUEST_ACCEPTED;
  }

  async verifyEmail(
    body: Readonly<{ flowId: string; flowVerifier: string; challengeId: string; verifier: string }>,
    headers: OperatorAuthHeaders,
  ): Promise<OperatorVerifyEmailResponse> {
    try {
      if (!await this.dependencies.admission.admitEmailVerification(headers)) return UNAUTHENTICATED;
    } catch { return UNAUTHENTICATED; }
    try {
      const smsChallenge = this.credentials.challenge();
      const otp = this.credentials.otp();
      const result = await this.dependencies.store.verifyEmail({
        flowId: body.flowId, flowVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        flowDigest: this.dependencies.cryptography.digestFlow(body.flowId, body.flowVerifier),
        emailChallengeId: body.challengeId, emailChallengeVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        emailChallengeDigest: this.dependencies.cryptography.digestChallenge(body.challengeId, "sign_in", "email_magic_link", body.verifier),
        smsChallengeId: smsChallenge.id, smsChallengeVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        smsChallengeDigest: this.dependencies.cryptography.digestChallenge(smsChallenge.id, "sign_in", "sms_otp", otp),
        correlationId: this.correlationId(),
      });
      if (result.outcome !== "verified" || result.smsChallengeId !== smsChallenge.id
          || !E164.test(result.normalizedPhone) || !validDate(result.expiresAt)) return UNAUTHENTICATED;
      const sms = Object.freeze({ normalizedPhone: result.normalizedPhone, otp, purpose: "sign_in" as const });
      this.track(() => this.dependencies.delivery.sendSmsOtp(sms));
      return Object.freeze({ mfaRequired: true as const, smsChallengeId: smsChallenge.id });
    } catch { return UNAVAILABLE; }
  }

  async verifySms(
    body: Readonly<{ flowId: string; flowVerifier: string; challengeId: string; otp: string }>,
    headers: OperatorAuthHeaders,
  ): Promise<OperatorVerifySmsResponse> {
    try {
      if (!await this.dependencies.admission.admitSmsVerification(headers)) return UNAUTHENTICATED;
    } catch { return UNAUTHENTICATED; }
    try {
      const session = this.credentials.session();
      const result = await this.dependencies.store.finishSignIn({
        flowId: body.flowId, flowVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        flowDigest: this.dependencies.cryptography.digestFlow(body.flowId, body.flowVerifier),
        smsChallengeId: body.challengeId, smsChallengeVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        smsChallengeDigest: this.dependencies.cryptography.digestChallenge(body.challengeId, "sign_in", "sms_otp", body.otp),
        sessionId: session.id, sessionVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        sessionDigest: this.dependencies.cryptography.digestSession(session.id, session.bearer),
        correlationId: this.correlationId(),
      });
      if (result.outcome !== "authenticated" || result.sessionId !== session.id || !validUuid(result.operatorId)
          || !validDate(result.absoluteExpiresAt) || !validDate(result.idleExpiresAt)) return UNAUTHENTICATED;
      const now = this.dependencies.clock().getTime();
      const absoluteExpiresAt = result.absoluteExpiresAt.getTime();
      const idleExpiresAt = result.idleExpiresAt.getTime();
      if (!Number.isFinite(now) || absoluteExpiresAt - now < 1_000 || idleExpiresAt - now < 1_000
          || idleExpiresAt > absoluteExpiresAt) return UNAUTHENTICATED;
      const identity = publicIdentity(result.displayName, result.roleCodes);
      if (!identity) return UNAUTHENTICATED;
      const publicResult = Object.freeze({ authenticated: true as const, displayName: identity.displayName, roles: identity.roles });
      const cookie = Object.freeze({ sessionId: session.id, bearer: session.bearer,
        absoluteExpiresAt: new Date(absoluteExpiresAt) });
      const adapterResult = { public: publicResult } as {
        public: typeof publicResult;
        cookie: typeof cookie;
      };
      // Cookie material is adapter-internal and deliberately absent from JSON
      // serialization even if an adapter accidentally serializes this wrapper.
      Object.defineProperty(adapterResult, "cookie", {
        value: cookie, enumerable: false, writable: false, configurable: false,
      });
      return Object.freeze(adapterResult);
    } catch { return UNAVAILABLE; }
  }

  async session(credential: OperatorSessionCredential): Promise<OperatorSessionResponse> {
    try {
      const result = await this.dependencies.store.validateSession({
        ...this.sessionInput(credential), roleCode: null, gateCode: "read",
      });
      if (result.outcome !== "authorized" || result.gateCode !== "read" || !validUuid(result.operatorId)
          || !validDate(result.absoluteExpiresAt) || !validDate(result.idleExpiresAt)
          || (result.reauthenticatedAt !== null && !validDate(result.reauthenticatedAt))) return UNAUTHENTICATED;
      const identity = publicIdentity(result.displayName, result.roleCodes);
      if (!identity) return UNAUTHENTICATED;
      const threshold = this.dependencies.clock().getTime() - 300_000;
      const smsReauthFresh = result.reauthenticatedAt !== null && result.reauthenticatedAt.getTime() > threshold;
      return Object.freeze({ authenticated: true as const, displayName: identity.displayName,
        roles: identity.roles, smsReauthFresh });
    } catch { return UNAVAILABLE; }
  }

  async logout(credential: OperatorSessionCredential | null): Promise<OperatorLogoutResponse> {
    if (credential === null) return LOGOUT_SUCCESS;
    try {
      const result = await this.dependencies.store.revoke(this.sessionInput(credential));
      return result.outcome === "accepted" ? LOGOUT_SUCCESS : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  }

  async requestReauth(
    credential: OperatorSessionCredential,
    headers: OperatorAuthHeaders,
  ): Promise<OperatorRequestReauthResponse> {
    try {
      if (!await this.dependencies.admission.admitReauthIssuance(headers, credential.sessionId)) return UNAUTHENTICATED;
    } catch { return UNAUTHENTICATED; }
    try {
      const challenge = this.credentials.challenge();
      const otp = this.credentials.otp();
      const result = await this.dependencies.store.beginReauth({
        ...this.sessionInput(credential), challengeId: challenge.id,
        challengeVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        challengeDigest: this.dependencies.cryptography.digestChallenge(challenge.id, "reauth", "sms_otp", otp),
      });
      if (result.outcome !== "started" || result.challengeId !== challenge.id
          || !E164.test(result.normalizedPhone) || !validDate(result.expiresAt)) return UNAUTHENTICATED;
      const sms = Object.freeze({ normalizedPhone: result.normalizedPhone, otp, purpose: "reauth" as const });
      this.track(() => this.dependencies.delivery.sendSmsOtp(sms));
      return OPERATOR_AUTH_REQUEST_ACCEPTED;
    } catch { return UNAVAILABLE; }
  }

  async verifyReauth(
    credential: OperatorSessionCredential,
    body: Readonly<{ challengeId: string; otp: string }>,
    headers: OperatorAuthHeaders,
  ): Promise<OperatorVerifyReauthResponse> {
    try {
      if (!await this.dependencies.admission.admitReauthVerification(headers, credential.sessionId)) return NOT_REAUTHENTICATED;
    } catch { return NOT_REAUTHENTICATED; }
    try {
      const result = await this.dependencies.store.finishReauth({
        ...this.sessionInput(credential), challengeId: body.challengeId,
        challengeVersion: OPERATOR_AUTH_VERIFIER_VERSION,
        challengeDigest: this.dependencies.cryptography.digestChallenge(body.challengeId, "reauth", "sms_otp", body.otp),
      });
      if (result.outcome !== "reauthenticated" || !validDate(result.reauthenticatedAt)) return NOT_REAUTHENTICATED;
      return Object.freeze({ reauthenticated: true as const, validForSeconds: 300 as const });
    } catch { return UNAVAILABLE; }
  }
}
