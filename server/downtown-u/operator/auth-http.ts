import { TextDecoder } from "node:util";

export const OPERATOR_AUTH_MAX_BODY_BYTES = 8 * 1024;
export const OPERATOR_AUTH_MAX_COOKIE_BYTES = 4_096;
export const OPERATOR_SESSION_MAX_AGE_SECONDS = 28_800;
export const OPERATOR_SESSION_COOKIE_NAME = "__Host-downtown_u_operator_session";

export const OPERATOR_AUTH_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER = /^[A-Za-z0-9_-]{43}$/;
const OTP = /^\d{6}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type OperatorAuthPostEndpoint = "request-link" | "verify-email" | "verify-sms" | "logout" | "reauth-request" | "reauth-verify";
export type OperatorAuthPostBody =
  | { email: string }
  | { flowId: string; flowVerifier: string; challengeId: string; verifier: string }
  | { flowId: string; flowVerifier: string; challengeId: string; otp: string }
  | Record<string, never>
  | { challengeId: string; otp: string };

export interface OperatorRawRequest extends AsyncIterable<Uint8Array | string> {
  method?: unknown;
  headers?: unknown;
  rawHeaders?: unknown;
}

export interface OperatorSessionCredential { sessionId: string; bearer: string }

/** A deliberately value-free error suitable for mapping to a generic 4xx response. */
export class OperatorAuthBoundaryError extends Error {
  readonly code = "invalid_request";
  constructor() { super("Invalid operator auth request"); this.name = "OperatorAuthBoundaryError"; }
}

function invalid(): never { throw new OperatorAuthBoundaryError(); }

/** Resolve DOWNTOWN_U_PUBLIC_APP_ORIGIN and fail closed unless it is one canonical HTTPS origin. */
export function parseOperatorPublicOrigin(value: string | undefined = process.env.DOWNTOWN_U_PUBLIC_APP_ORIGIN): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error("Invalid operator public origin configuration");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
      || parsed.pathname !== "/" || parsed.origin !== value) throw new Error();
    return parsed.origin;
  } catch { throw new Error("Invalid operator public origin configuration"); }
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeHeaders(request: object): Map<string, string> {
  const candidate = ownDataValue(request, "headers");
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) invalid();
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(candidate).length !== 0) invalid();
  const result = new Map<string, string>();
  for (const key of Object.keys(candidate)) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") invalid();
    const lower = key.toLowerCase();
    if (key === "" || result.has(lower) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) invalid();
    if (/[^\t\x20-\x7e\x80-\xff]/.test(descriptor.value)) invalid();
    result.set(lower, descriptor.value);
  }

  const rawDescriptor = Object.getOwnPropertyDescriptor(request, "rawHeaders");
  if (rawDescriptor) {
    if (!("value" in rawDescriptor)) invalid();
    const raw = rawDescriptor.value;
    if (!Array.isArray(raw) || raw.length % 2 !== 0) invalid();
    const seen = new Set<string>();
    for (let index = 0; index < raw.length; index += 2) {
      if (typeof raw[index] !== "string" || typeof raw[index + 1] !== "string") invalid();
      const lower = raw[index].toLowerCase();
      if (seen.has(lower) || result.get(lower) !== raw[index + 1]) invalid();
      seen.add(lower);
    }
    if (seen.size !== result.size) invalid();
  }
  return result;
}

function safeMethod(request: object): string {
  const method = ownDataValue(request, "method");
  return typeof method === "string" ? method : invalid();
}

function assertOrigin(headers: Map<string, string>, configuredOrigin: string, required: boolean): void {
  const origin = headers.get("origin");
  if ((required && origin === undefined) || (origin !== undefined && origin !== configuredOrigin)) invalid();
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") invalid();
}

function asyncIterator(request: object): (() => AsyncIterator<Uint8Array | string>) | undefined {
  let current: object | null = request;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.asyncIterator);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as () => AsyncIterator<Uint8Array | string> : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

async function readRaw(request: object, maxBytes: number): Promise<Uint8Array> {
  const getIterator = asyncIterator(request);
  if (!getIterator) invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const iterator = getIterator.call(request);
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      const chunk = typeof item.value === "string" ? Buffer.from(item.value) : item.value;
      if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1) invalid();
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      length += bytes.byteLength;
      if (length > maxBytes) { if (typeof iterator.return === "function") await iterator.return(); invalid(); }
      chunks.push(bytes);
    }
  } catch (error) { if (error instanceof OperatorAuthBoundaryError) throw error; invalid(); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

class StrictJsonParser {
  private index = 0;
  constructor(private readonly text: string) {}
  parse(): unknown { this.space(); const value = this.value(); this.space(); if (this.index !== this.text.length) invalid(); return value; }
  private space(): void { while (/[\t\n\r ]/.test(this.text[this.index] ?? "")) this.index += 1; }
  private value(): unknown {
    this.space(); const char = this.text[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number();
  }
  private object(): Record<string, unknown> {
    this.index += 1; this.space(); const result = Object.create(null) as Record<string, unknown>; const keys = new Set<string>();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    while (true) {
      if (this.text[this.index] !== '"') invalid();
      const key = this.string();
      if (keys.has(key) || FORBIDDEN_JSON_KEYS.has(key)) invalid();
      keys.add(key); this.space(); if (this.text[this.index++] !== ":") invalid();
      result[key] = this.value(); this.space(); const separator = this.text[this.index++];
      if (separator === "}") return result;
      if (separator !== ",") invalid();
      this.space();
    }
  }
  private array(): unknown[] {
    this.index += 1; this.space(); const result: unknown[] = [];
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    while (true) { result.push(this.value()); this.space(); const separator = this.text[this.index++]; if (separator === "]") return result; if (separator !== ",") invalid(); }
  }
  private string(): string {
    const start = this.index; this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) { this.index += 1; const encoded = this.text.slice(start, this.index); try { return JSON.parse(encoded) as string; } catch { invalid(); } }
      if (code < 0x20) invalid();
      if (code === 0x5c) { this.index += 1; const escape = this.text[this.index]; if (!'"\\/bfnrtu'.includes(escape ?? "")) invalid(); if (escape === "u" && !/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) invalid(); if (escape === "u") this.index += 4; }
      this.index += 1;
    }
    return invalid();
  }
  private number(): number {
    const rest = this.text.slice(this.index); const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) invalid(); this.index += match[0].length; const value = Number(match[0]); return Number.isFinite(value) ? value : invalid();
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) invalid();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(); }
  return value as Record<string, unknown>;
}
function textField(body: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = body[key]; if (typeof value !== "string" || !pattern.test(value)) invalid(); return value;
}
function normalizedEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim() || value !== value.toLowerCase() || value !== value.normalize("NFC") || !EMAIL.test(value)) invalid();
  return value;
}
function validateBody(endpoint: OperatorAuthPostEndpoint, value: unknown): OperatorAuthPostBody {
  if (endpoint === "request-link") { const body = exactObject(value, ["email"]); return { email: normalizedEmail(body.email) }; }
  if (endpoint === "verify-email") { const body = exactObject(value, ["flowId", "flowVerifier", "challengeId", "verifier"]); return { flowId: textField(body, "flowId", UUID), flowVerifier: textField(body, "flowVerifier", BEARER), challengeId: textField(body, "challengeId", UUID), verifier: textField(body, "verifier", BEARER) }; }
  if (endpoint === "verify-sms") { const body = exactObject(value, ["flowId", "flowVerifier", "challengeId", "otp"]); return { flowId: textField(body, "flowId", UUID), flowVerifier: textField(body, "flowVerifier", BEARER), challengeId: textField(body, "challengeId", UUID), otp: textField(body, "otp", OTP) }; }
  if (endpoint === "reauth-verify") { const body = exactObject(value, ["challengeId", "otp"]); return { challengeId: textField(body, "challengeId", UUID), otp: textField(body, "otp", OTP) }; }
  exactObject(value, []); return {};
}

export async function parseOperatorPostRequest(request: unknown, endpoint: OperatorAuthPostEndpoint, configuredOrigin: string): Promise<OperatorAuthPostBody> {
  if (!["request-link", "verify-email", "verify-sms", "logout", "reauth-request", "reauth-verify"].includes(endpoint)) invalid();
  if (typeof request !== "object" || request === null || Array.isArray(request)) invalid();
  if (safeMethod(request) !== "POST") invalid();
  if (Object.getOwnPropertyDescriptor(request, "body") !== undefined) invalid();
  const headers = safeHeaders(request);
  assertOrigin(headers, configuredOrigin, true);
  if (headers.get("content-type") !== "application/json" || headers.has("transfer-encoding")) invalid();
  const declared = headers.get("content-length");
  if (declared !== undefined && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > OPERATOR_AUTH_MAX_BODY_BYTES)) invalid();
  const bytes = await readRaw(request, OPERATOR_AUTH_MAX_BODY_BYTES);
  if (declared !== undefined && Number(declared) !== bytes.byteLength) invalid();
  if (bytes.byteLength === 0) invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return invalid(); }
  return validateBody(endpoint, new StrictJsonParser(text).parse());
}

export async function parseOperatorAuthenticatedGet(request: unknown, configuredOrigin: string): Promise<void> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) invalid();
  if (safeMethod(request) !== "GET" || Object.getOwnPropertyDescriptor(request, "body") !== undefined) invalid();
  const headers = safeHeaders(request);
  assertOrigin(headers, configuredOrigin, false);
  if (headers.has("content-type") || headers.has("transfer-encoding") || headers.has("content-length")) invalid();
  const body = await readRaw(request, 0);
  if (body.byteLength !== 0) invalid();
}

export function parseOperatorSessionCookie(raw: unknown): OperatorSessionCredential | null {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw) > OPERATOR_AUTH_MAX_COOKIE_BYTES || hasControlCharacter(raw)) return null;
  let match: string | undefined;
  for (const part of raw.split(";")) {
    const item = part.trim(); const equals = item.indexOf("="); if (equals < 1) return null;
    const name = item.slice(0, equals); const value = item.slice(equals + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x21-\x7e]*$/.test(value)) return null;
    if (name === OPERATOR_SESSION_COOKIE_NAME) { if (match !== undefined) return null; match = value; }
  }
  if (match === undefined) return null;
  const credential = /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(match);
  return credential && UUID.test(credential[1]) ? { sessionId: credential[1], bearer: credential[2] } : null;
}

export function serializeOperatorSessionCookie(sessionId: string, bearer: string, maxAgeSeconds: number): string {
  if (!UUID.test(sessionId) || !BEARER.test(bearer) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > OPERATOR_SESSION_MAX_AGE_SECONDS)
    throw new Error("Invalid operator session cookie");
  return `${OPERATOR_SESSION_COOKIE_NAME}=v1.${sessionId}.${bearer}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOperatorSessionCookie(): string {
  return `${OPERATOR_SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
