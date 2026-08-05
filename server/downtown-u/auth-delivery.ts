import type { AuthDeliverySink, PendingAuthDelivery } from "./auth-service";

const MAX_PROVIDER_RESPONSE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 5_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const OTP = /^\d{6}$/;

export class AuthDeliveryConfigurationError extends Error {
  constructor() { super("Authentication delivery is not configured"); this.name = "AuthDeliveryConfigurationError"; }
}
export class AuthDeliveryError extends Error {
  constructor(kind: "timeout" | "provider") { super(`Authentication delivery ${kind} failure`); this.name = "AuthDeliveryError"; }
}

export interface EmailAuthMessage { to: string; magicLink: string; expiresAt: Date }
export interface SmsAuthMessage { to: string; otp: string; challengeId: string; expiresAt: Date }
export interface AuthEmailProvider { send(message: EmailAuthMessage): Promise<void> }
export interface AuthSmsProvider { send(message: SmsAuthMessage): Promise<void> }

function publicOrigin(value: string | undefined): string {
  if (!value) throw new AuthDeliveryConfigurationError();
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthDeliveryConfigurationError(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new AuthDeliveryConfigurationError();
  }
  return url.origin;
}

export function createMagicLink(origin: string, challengeId: string, verifier: string): string {
  const trustedOrigin = publicOrigin(origin);
  if (!OPAQUE_ID.test(challengeId) || !OPAQUE_ID.test(verifier)) throw new AuthDeliveryError("provider");
  const url = new URL("/downtown-u/auth/verify", trustedOrigin);
  // Credentials belong only in the client-side fragment, never in an HTTP request target.
  url.hash = new URLSearchParams({ challengeId, verifier }).toString();
  return url.toString();
}

export function createEmailAuthDeliverySink(config: {
  publicAppOrigin: string; email: AuthEmailProvider;
}): AuthDeliverySink {
  const origin = publicOrigin(config.publicAppOrigin);
  return Object.freeze({
    async deliver(delivery: PendingAuthDelivery): Promise<void> {
      if (delivery.method !== "email_magic_link"
        || !(delivery.expiresAt instanceof Date) || !Number.isFinite(delivery.expiresAt.getTime())) {
        throw new AuthDeliveryError("provider");
      }
      await config.email.send({
        to: delivery.normalizedContact,
        magicLink: createMagicLink(origin, delivery.challengeId, delivery.verifier),
        expiresAt: delivery.expiresAt,
      });
    },
  });
}

export function createSmsAuthDeliverySink(config: { sms: AuthSmsProvider }): AuthDeliverySink {
  return Object.freeze({
    async deliver(delivery: PendingAuthDelivery): Promise<void> {
      if (delivery.method !== "sms_otp" || !OTP.test(delivery.verifier) || !OPAQUE_ID.test(delivery.challengeId)
        || !(delivery.expiresAt instanceof Date) || !Number.isFinite(delivery.expiresAt.getTime())) {
        throw new AuthDeliveryError("provider");
      }
      await config.sms.send({
        to: delivery.normalizedContact, otp: delivery.verifier, challengeId: delivery.challengeId, expiresAt: delivery.expiresAt,
      });
    },
  });
}

export function createAuthDeliverySink(config: {
  publicAppOrigin: string; email: AuthEmailProvider; sms: AuthSmsProvider;
}): AuthDeliverySink {
  const origin = publicOrigin(config.publicAppOrigin);
  return Object.freeze({
    async deliver(delivery: PendingAuthDelivery): Promise<void> {
      if (!(delivery.expiresAt instanceof Date) || !Number.isFinite(delivery.expiresAt.getTime())) throw new AuthDeliveryError("provider");
      if (delivery.method === "email_magic_link") {
        await config.email.send({
          to: delivery.normalizedContact,
          magicLink: createMagicLink(origin, delivery.challengeId, delivery.verifier),
          expiresAt: delivery.expiresAt,
        });
        return;
      }
      if (delivery.method === "sms_otp" && OTP.test(delivery.verifier) && OPAQUE_ID.test(delivery.challengeId)) {
        await config.sms.send({
          to: delivery.normalizedContact, otp: delivery.verifier, challengeId: delivery.challengeId, expiresAt: delivery.expiresAt,
        });
        return;
      }
      throw new AuthDeliveryError("provider");
    },
  });
}

type Fetch = typeof fetch;
async function providerFetch(fetchImpl: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    // Consume only a bounded amount and discard it. Provider response text is never retained in an error.
    if (response.body) {
      const reader = response.body.getReader(); let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_PROVIDER_RESPONSE_BYTES) { await reader.cancel(); throw new AuthDeliveryError("provider"); }
      }
    }
    if (!response.ok) throw new AuthDeliveryError("provider");
  } catch (error) {
    if (error instanceof AuthDeliveryError) throw error;
    throw new AuthDeliveryError(controller.signal.aborted ? "timeout" : "provider");
  } finally { clearTimeout(timer); }
}

function required(value: string | undefined): string {
  if (!value || /[\r\n]/.test(value)) throw new AuthDeliveryConfigurationError();
  return value;
}
function positiveTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d{1,5}$/.test(value)) throw new AuthDeliveryConfigurationError();
  const timeout = Number(value);
  if (timeout < 100 || timeout > 30_000) throw new AuthDeliveryConfigurationError();
  return timeout;
}

export function createResendEmailProvider(config: {
  apiKey: string | undefined; from: string | undefined; fetch?: Fetch; timeoutMs?: number;
}): AuthEmailProvider {
  const apiKey = required(config.apiKey); const from = required(config.from);
  const fetchImpl = config.fetch ?? fetch; const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async send(message: EmailAuthMessage): Promise<void> {
      const minutes = Math.max(1, Math.ceil((message.expiresAt.getTime() - Date.now()) / 60_000));
      await providerFetch(fetchImpl, "https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [message.to], subject: "Your Downtown U sign-in link",
          text: `Use this secure link to sign in to Downtown U (expires in ${minutes} minutes): ${message.magicLink}` }),
      }, timeoutMs);
    },
  });
}

export function createTwilioSmsProvider(config: {
  accountSid: string | undefined; authToken: string | undefined; from: string | undefined; fetch?: Fetch; timeoutMs?: number;
}): AuthSmsProvider {
  const sid = required(config.accountSid); const token = required(config.authToken); const from = required(config.from);
  if (!/^AC[a-fA-F0-9]{32}$/.test(sid) || !/^\+[1-9]\d{7,14}$/.test(from)) throw new AuthDeliveryConfigurationError();
  const fetchImpl = config.fetch ?? fetch; const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async send(message: SmsAuthMessage): Promise<void> {
      const minutes = Math.max(1, Math.ceil((message.expiresAt.getTime() - Date.now()) / 60_000));
      const body = new URLSearchParams({ To: message.to, From: from,
        Body: `Your Downtown U code is ${message.otp}. Sign-in reference: ${message.challengeId}. It expires in ${minutes} minutes.` });
      await providerFetch(fetchImpl, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body,
      }, timeoutMs);
    },
  });
}

export function createAuthDeliveryFromEnvironment(env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch): AuthDeliverySink {
  const timeoutMs = positiveTimeout(env.DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS);
  return createAuthDeliverySink({ publicAppOrigin: env.DOWNTOWN_U_PUBLIC_APP_ORIGIN ?? "",
    email: createResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.DOWNTOWN_U_AUTH_EMAIL_FROM, fetch: fetchImpl, timeoutMs }),
    sms: createTwilioSmsProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
      from: env.DOWNTOWN_U_AUTH_SMS_FROM, fetch: fetchImpl, timeoutMs }),
  });
}

/** Endpoint-narrow factories deliberately do not inspect the other provider's environment. */
export function createEmailAuthDeliveryFromEnvironment(env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch): AuthDeliverySink {
  const timeoutMs = positiveTimeout(env.DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS);
  return createEmailAuthDeliverySink({
    publicAppOrigin: env.DOWNTOWN_U_PUBLIC_APP_ORIGIN ?? "",
    email: createResendEmailProvider({
      apiKey: env.RESEND_API_KEY, from: env.DOWNTOWN_U_AUTH_EMAIL_FROM, fetch: fetchImpl, timeoutMs,
    }),
  });
}

export function createSmsAuthDeliveryFromEnvironment(env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch): AuthDeliverySink {
  const timeoutMs = positiveTimeout(env.DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS);
  return createSmsAuthDeliverySink({
    sms: createTwilioSmsProvider({
      accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
      from: env.DOWNTOWN_U_AUTH_SMS_FROM, fetch: fetchImpl, timeoutMs,
    }),
  });
}
