import { normalizeEmail } from "../identity";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TWILIO_API_ORIGIN = "https://api.twilio.com";
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const MIN_PROVIDER_TIMEOUT_MS = 100;
const MAX_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 4_096;
const MAX_SECRET_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const OTP_PATTERN = /^\d{6}$/;
const TWILIO_ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const TWILIO_MESSAGE_SID_PATTERN = /^SM[a-fA-F0-9]{32}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Fetch = typeof fetch;

export class OperatorAuthDeliveryConfigurationError extends Error {
  constructor() {
    super("Operator authentication delivery is not configured");
    this.name = "OperatorAuthDeliveryConfigurationError";
  }
}

export class OperatorAuthDeliveryError extends Error {
  constructor() {
    super("Operator authentication delivery failed");
    this.name = "OperatorAuthDeliveryError";
  }
}

export interface OperatorAuthDeliveryDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: Fetch;
}

export interface SendOperatorMagicLinkInput {
  readonly normalizedEmail: string;
  readonly publicOrigin: string;
  readonly flowId: string;
  readonly flowVerifier: string;
  readonly challengeId: string;
  readonly challengeVerifier: string;
}

export interface SendOperatorSmsOtpInput {
  readonly normalizedPhone: string;
  readonly otp: string;
  readonly purpose: "sign_in" | "reauth";
}

function configurationValue(value: string | undefined): string {
  if (!value
      || value.trim() !== value
      || value.length > MAX_SECRET_LENGTH
      || /[\r\n\0]/.test(value)) {
    throw new OperatorAuthDeliveryConfigurationError();
  }
  return value;
}

function configuredEmailSender(value: string | undefined): string {
  const sender = configurationValue(value);
  if (sender.length > 320 || /[<>]/.test(sender.replace(/<[^<>]*>$/, ""))) {
    throw new OperatorAuthDeliveryConfigurationError();
  }
  const angleAddress = sender.match(/<([^<>]+)>$/)?.[1];
  const address = angleAddress ?? sender;
  try {
    if (normalizeEmail(address) !== address) throw new Error("not normalized");
  } catch {
    throw new OperatorAuthDeliveryConfigurationError();
  }
  return sender;
}

function configuredE164Sender(value: string | undefined): string {
  const sender = configurationValue(value);
  if (!E164_PATTERN.test(sender)) throw new OperatorAuthDeliveryConfigurationError();
  return sender;
}

function providerTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!/^\d{3,5}$/.test(raw)) throw new OperatorAuthDeliveryConfigurationError();
  const timeout = Number(raw);
  if (timeout < MIN_PROVIDER_TIMEOUT_MS || timeout > MAX_PROVIDER_TIMEOUT_MS) {
    throw new OperatorAuthDeliveryConfigurationError();
  }
  return timeout;
}

function validateEmailInput(input: SendOperatorMagicLinkInput): URL {
  try {
    if (normalizeEmail(input.normalizedEmail) !== input.normalizedEmail) throw new Error("not normalized");
  } catch {
    throw new OperatorAuthDeliveryError();
  }
  if (!UUID_PATTERN.test(input.flowId)
      || !UUID_PATTERN.test(input.challengeId)
      || !VERIFIER_PATTERN.test(input.flowVerifier)
      || !VERIFIER_PATTERN.test(input.challengeVerifier)) {
    throw new OperatorAuthDeliveryError();
  }

  let origin: URL;
  try {
    origin = new URL(input.publicOrigin);
  } catch {
    throw new OperatorAuthDeliveryError();
  }
  if (origin.protocol !== "https:"
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== "") {
    throw new OperatorAuthDeliveryError();
  }
  return origin;
}

function operatorMagicLink(origin: URL, input: SendOperatorMagicLinkInput): string {
  const link = new URL("/", origin.origin);
  const credentials = new URLSearchParams({
    flowId: input.flowId,
    flowVerifier: input.flowVerifier,
    challengeId: input.challengeId,
    verifier: input.challengeVerifier,
  });
  // The HTTP request target is always "/". The SPA route and all credentials
  // remain after "#", so browsers do not transmit them to an HTTP server.
  link.hash = `/downtown-u/operator/auth?${credentials.toString()}`;
  return link.toString();
}

function validateSmsInput(input: SendOperatorSmsOtpInput): void {
  if (!E164_PATTERN.test(input.normalizedPhone)
      || !OTP_PATTERN.test(input.otp)
      || (input.purpose !== "sign_in" && input.purpose !== "reauth")) {
    throw new OperatorAuthDeliveryError();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new OperatorAuthDeliveryError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OperatorAuthDeliveryError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OperatorAuthDeliveryError();
  }
}

function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

async function fetchProvider(
  fetchImpl: Fetch,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  validResponse: (body: unknown) => boolean,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, { ...init, signal: controller.signal });
    const body = await readBoundedJson(response);
    if (!response.ok || !validResponse(body)) throw new OperatorAuthDeliveryError();
  } catch {
    // Provider status, body, transport, and timeout details are deliberately
    // collapsed into one redacted boundary error.
    throw new OperatorAuthDeliveryError();
  } finally {
    clearTimeout(timer);
  }
}

export async function sendOperatorMagicLink(
  input: SendOperatorMagicLinkInput,
  dependencies: OperatorAuthDeliveryDependencies = {},
): Promise<void> {
  const origin = validateEmailInput(input);
  const env = dependencies.env ?? process.env;
  // Load only Resend/operator-email variables at the email delivery boundary.
  const apiKey = configurationValue(env.RESEND_API_KEY);
  const from = configuredEmailSender(env.DOWNTOWN_U_OPERATOR_AUTH_EMAIL_FROM);
  const timeoutMs = providerTimeout(env);
  const fetchImpl = dependencies.fetch ?? fetch;
  const magicLink = operatorMagicLink(origin, input);

  await fetchProvider(fetchImpl, RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.normalizedEmail],
      subject: "Downtown U operator sign-in",
      text: `Use this link to continue Downtown U operator sign-in. It expires shortly: ${magicLink}`,
    }),
  }, timeoutMs, (body) => {
    const id = ownString(body, "id");
    return id !== undefined && PROVIDER_ID_PATTERN.test(id);
  });
}

export async function sendOperatorSmsOtp(
  input: SendOperatorSmsOtpInput,
  dependencies: OperatorAuthDeliveryDependencies = {},
): Promise<void> {
  validateSmsInput(input);
  const env = dependencies.env ?? process.env;
  // Load only Twilio/operator-SMS variables at the SMS delivery boundary.
  const accountSid = configurationValue(env.TWILIO_ACCOUNT_SID);
  const authToken = configurationValue(env.TWILIO_AUTH_TOKEN);
  const from = configuredE164Sender(env.DOWNTOWN_U_OPERATOR_AUTH_SMS_FROM);
  if (!TWILIO_ACCOUNT_SID_PATTERN.test(accountSid)) {
    throw new OperatorAuthDeliveryConfigurationError();
  }
  const timeoutMs = providerTimeout(env);
  const fetchImpl = dependencies.fetch ?? fetch;
  const message = input.purpose === "reauth"
    ? `Downtown U operator reauthentication code: ${input.otp}. Expires in 5 minutes.`
    : `Downtown U operator verification code: ${input.otp}. Expires in 5 minutes.`;
  const body = new URLSearchParams({ To: input.normalizedPhone, From: from, Body: message });

  await fetchProvider(
    fetchImpl,
    `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    },
    timeoutMs,
    (providerBody) => {
      const sid = ownString(providerBody, "sid");
      return sid !== undefined && TWILIO_MESSAGE_SID_PATTERN.test(sid);
    },
  );
}
