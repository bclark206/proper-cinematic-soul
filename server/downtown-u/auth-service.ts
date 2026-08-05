import {
  createAuthCryptography, generateBearerToken, generateMagicLinkToken, generateOpaqueId, generateOtp,
  type AuthContactType, type AuthCryptography, type AuthMethod,
} from "./auth";
import { normalizeEmail, normalizePhone } from "./identity";
import type { AuthStore, ValidateSessionResult } from "./postgres-auth-store";

/** Deliberately constant public request response. */
export type AuthRequestResponse = Readonly<{ accepted: true }>;
export const AUTH_REQUEST_ACCEPTED: AuthRequestResponse = Object.freeze({ accepted: true });

/** Ephemeral secret material passed only to the injected internal delivery boundary. */
export interface PendingAuthDelivery {
  challengeId: string;
  method: AuthMethod;
  normalizedContact: string;
  verifier: string;
  expiresAt: Date;
}

/** Internal Phase 3B boundary. Implementations must not retain or log delivery material. */
export interface AuthDeliverySink {
  deliver(delivery: PendingAuthDelivery): Promise<void>;
}

export type AuthRequestErrorObserver = (error: unknown) => void | Promise<void>;
const NOOP_DELIVERY_SINK: AuthDeliverySink = Object.freeze({ deliver: async () => undefined });

export class DowntownUAuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly cryptography: AuthCryptography,
    private readonly deliverySink: AuthDeliverySink = NOOP_DELIVERY_SINK,
    private readonly observeRequestError?: AuthRequestErrorObserver,
  ) {}

  /** Enumeration-resistant boundary: every request resolves to the same public object. */
  async request(contactType: AuthContactType, contact: string): Promise<AuthRequestResponse> {
    try {
      if (contactType !== "email" && contactType !== "phone") return AUTH_REQUEST_ACCEPTED;
      const normalizedContact = contactType === "email" ? normalizeEmail(contact) : normalizePhone(contact);
      const method: AuthMethod = contactType === "email" ? "email_magic_link" : "sms_otp";
      const verifier = method === "email_magic_link" ? generateMagicLinkToken() : generateOtp();
      const result = await this.store.createChallenge({
        challengeId: generateOpaqueId(), contactType, normalizedContact, method,
        digest: this.cryptography.digestChallenge(verifier),
      });
      if (result.challengeId && result.expiresAt) {
        await this.deliverySink.deliver({
          challengeId: result.challengeId, method, normalizedContact, verifier, expiresAt: result.expiresAt,
        });
      }
    } catch (error) {
      try { await Promise.resolve(this.observeRequestError?.(error)); }
      catch { /* Diagnostics cannot alter the public response. */ }
    }
    return AUTH_REQUEST_ACCEPTED;
  }

  async verify(challengeId: string, verifier: string): Promise<
    | { outcome:"invalid" }
    | { outcome:"authenticated"; sessionId:string; bearerToken:string; studentId:string; expiresAt:Date }
  > {
    const sessionId=generateOpaqueId(); const bearerToken=generateBearerToken();
    const result=await this.store.consumeChallenge({ challengeId,digest:this.cryptography.digestChallenge(verifier),
      sessionId,sessionDigest:this.cryptography.digestSession(bearerToken) });
    return result.outcome==="invalid" ? result : { ...result,bearerToken };
  }

  validate(sessionId:string,bearerToken:string):Promise<ValidateSessionResult> {
    return this.store.validateSession({sessionId,digest:this.cryptography.digestSession(bearerToken)});
  }
  revoke(sessionId:string,bearerToken:string):Promise<{outcome:"accepted"}> {
    return this.store.revokeSession({sessionId,digest:this.cryptography.digestSession(bearerToken)});
  }
}

export function createDowntownUAuthService(
  store:AuthStore, secret:string|undefined, deliverySink:AuthDeliverySink = NOOP_DELIVERY_SINK,
  observeRequestError?:AuthRequestErrorObserver,
):DowntownUAuthService {
  return new DowntownUAuthService(store,createAuthCryptography(secret),deliverySink,observeRequestError);
}
