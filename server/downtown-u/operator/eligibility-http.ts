import { TextDecoder, types } from "node:util";
import { parseOperatorSessionCookie, type OperatorSessionCredential } from "./auth-http";
import { isCanonicalUuid, validateEligibilityMutationBody, type OperatorEligibilityMutationBody } from "./eligibility-types";
import { isUnproxiedObject } from "./trusted-result";

export const OPERATOR_ELIGIBILITY_MAX_BODY_BYTES = 8 * 1024;
export const OPERATOR_ELIGIBILITY_ENDPOINT = "/api/downtown-u/operator/eligibility-decisions";
const IDEMPOTENCY = /^opm:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")?.get;

export interface OperatorEligibilityRawRequest extends AsyncIterable<Uint8Array | string> {
  method?: unknown; url?: unknown; headers?: unknown; rawHeaders?: unknown;
}
export interface ParsedOperatorEligibilityMutation {
  readonly body: OperatorEligibilityMutationBody;
  readonly credential: Readonly<OperatorSessionCredential>;
  readonly idempotencyKey: string;
}
export class OperatorEligibilityBoundaryError extends Error {
  constructor(readonly code: "invalid_request" | "forbidden" | "unauthorized" = "invalid_request") {
    super("Invalid operator eligibility request");
    this.name = "OperatorEligibilityBoundaryError";
  }
}
function invalid(): never { throw new OperatorEligibilityBoundaryError(); }
function own(object: object, key: PropertyKey): unknown {
  if (types.isProxy(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function headers(request: object): Map<string, string> {
  const source = own(request, "headers");
  if (!isUnproxiedObject(source) || Array.isArray(source)) invalid();
  if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) invalid();
  if (Object.getOwnPropertySymbols(source).length !== 0) invalid();
  const output = new Map<string, string>();
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) invalid();
    const lower = key.toLowerCase();
    if (output.has(lower) || /[^\t\x20-\x7e\x80-\xff]/.test(descriptor.value)) invalid();
    output.set(lower, descriptor.value);
  }
  const rawDescriptor = Object.getOwnPropertyDescriptor(request, "rawHeaders");
  if (!rawDescriptor || !("value" in rawDescriptor) || !isUnproxiedObject(rawDescriptor.value) || !Array.isArray(rawDescriptor.value)) invalid();
  const raw = rawDescriptor.value;
  if (Object.getPrototypeOf(raw) !== Array.prototype || Object.getOwnPropertySymbols(raw).length !== 0) invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || lengthDescriptor.value % 2 !== 0) invalid();
  const rawLength = lengthDescriptor.value;
  const rawNames = Object.getOwnPropertyNames(raw);
  if (rawNames.length !== rawLength + 1 || !rawNames.includes("length")) invalid();
  const seen = new Set<string>();
  for (let index = 0; index < rawLength; index += 2) {
    const nameDescriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    const valueDescriptor = Object.getOwnPropertyDescriptor(raw, String(index + 1));
    if (!nameDescriptor || !("value" in nameDescriptor) || !valueDescriptor || !("value" in valueDescriptor)) invalid();
    const name = nameDescriptor.value; const value = valueDescriptor.value;
    if (typeof name !== "string" || typeof value !== "string") invalid();
    const lower = name.toLowerCase();
    if (seen.has(lower) || output.get(lower) !== value) invalid();
    seen.add(lower);
  }
  if (seen.size !== output.size) invalid();
  return output;
}
function iteratorFactory(request: object): (() => AsyncIterator<Uint8Array | string>) | undefined {
  let current: object | null = request;
  while (current) {
    if (types.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.asyncIterator);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as () => AsyncIterator<Uint8Array | string> : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}
function dataMethod(object: object, key: PropertyKey): ((...args: never[]) => unknown) | undefined {
  let current: object | null = object;
  while (current) {
    if (types.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as (...args: never[]) => unknown : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}
function inspectChunk(value: unknown): Readonly<{ source: string | Uint8Array; byteLength: number }> {
  if (typeof value === "string") return { source: value, byteLength: Buffer.byteLength(value) };
  if (!isUnproxiedObject(value) || !ArrayBuffer.isView(value) || !TYPED_ARRAY_BUFFER || !TYPED_ARRAY_BYTE_OFFSET
    || !TYPED_ARRAY_BYTE_LENGTH || !TYPED_ARRAY_LENGTH) invalid();
  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER, value, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET, value, []) as number;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
    const length = Reflect.apply(TYPED_ARRAY_LENGTH, value, []) as number;
    if (length !== byteLength) invalid();
    return { source: new Uint8Array(buffer, byteOffset, byteLength), byteLength };
  } catch (error) { if (error instanceof OperatorEligibilityBoundaryError) throw error; invalid(); }
}
async function rawBody(request: object): Promise<Uint8Array> {
  const factory = iteratorFactory(request); if (!factory) invalid();
  const chunks: Uint8Array[] = []; let total = 0; let iterator: AsyncIterator<Uint8Array | string> | undefined;
  try {
    iterator = factory.call(request);
    if (!isUnproxiedObject(iterator)) invalid();
    const next = dataMethod(iterator, "next"); if (!next) invalid();
    while (true) {
      const part = await next.call(iterator);
      if (!isUnproxiedObject(part)) invalid();
      const done = own(part, "done"); if (typeof done !== "boolean") invalid();
      if (done) break;
      const value = own(part, "value");
      const inspected = inspectChunk(value);
      total += inspected.byteLength;
      if (total > OPERATOR_ELIGIBILITY_MAX_BODY_BYTES) { const close = dataMethod(iterator, "return"); if (close) await close.call(iterator); invalid(); }
      chunks.push(typeof inspected.source === "string" ? Buffer.from(inspected.source) : Uint8Array.from(inspected.source));
    }
  } catch (error) { if (error instanceof OperatorEligibilityBoundaryError) throw error; invalid(); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

class StrictJson {
  private index = 0;
  constructor(private readonly source: string) {}
  parse(): unknown { this.space(); const value = this.value(); this.space(); if (this.index !== this.source.length) invalid(); return value; }
  private space(): void { while (/[\t\n\r ]/.test(this.source[this.index] ?? "")) this.index++; }
  private value(): unknown {
    this.space(); const char = this.source[this.index];
    if (char === "{") return this.object(); if (char === "[") return this.array(); if (char === '"') return this.string();
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number();
  }
  private object(): Record<string, unknown> {
    this.index++; this.space(); const output = Object.create(null) as Record<string, unknown>; const keys = new Set<string>();
    if (this.source[this.index] === "}") { this.index++; return output; }
    while (true) {
      if (this.source[this.index] !== '"') invalid(); const key = this.string();
      if (keys.has(key) || FORBIDDEN_KEYS.has(key)) invalid(); keys.add(key);
      this.space(); if (this.source[this.index++] !== ":") invalid(); output[key] = this.value(); this.space();
      const delimiter = this.source[this.index++]; if (delimiter === "}") return output; if (delimiter !== ",") invalid(); this.space();
    }
  }
  private array(): unknown[] {
    this.index++; this.space(); const output: unknown[] = []; if (this.source[this.index] === "]") { this.index++; return output; }
    while (true) { output.push(this.value()); this.space(); const delimiter = this.source[this.index++]; if (delimiter === "]") return output; if (delimiter !== ",") invalid(); }
  }
  private string(): string {
    const start = this.index++;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) { this.index++; try { return JSON.parse(this.source.slice(start, this.index)) as string; } catch { invalid(); } }
      if (code < 0x20) invalid();
      if (code === 0x5c) { this.index++; const escape = this.source[this.index]; if (!'"\\/bfnrtu'.includes(escape ?? "")) invalid(); if (escape === "u") { if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) invalid(); this.index += 4; } }
      this.index++;
    }
    return invalid();
  }
  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) invalid(); this.index += match[0].length; const value = Number(match[0]); return Number.isFinite(value) ? value : invalid();
  }
}

export async function parseOperatorEligibilityMutationRequest(request: unknown, configuredOrigin: string): Promise<ParsedOperatorEligibilityMutation> {
  try {
    if (!isUnproxiedObject(request) || Array.isArray(request)) invalid();
    if (own(request, "method") !== "POST" || own(request, "url") !== OPERATOR_ELIGIBILITY_ENDPOINT
      || Object.getOwnPropertyDescriptor(request, "body") !== undefined) invalid();
    const safe = headers(request);
    const origin = safe.get("origin");
    if (origin !== configuredOrigin || (safe.has("sec-fetch-site") && safe.get("sec-fetch-site") !== "same-origin")) {
      throw new OperatorEligibilityBoundaryError("forbidden");
    }
    if (safe.get("content-type") !== "application/json" || safe.has("transfer-encoding")) invalid();
    const key = safe.get("idempotency-key"); if (!key || !IDEMPOTENCY.test(key)) invalid();
    const rawCookie = safe.get("cookie");
    const credential = parseOperatorSessionCookie(rawCookie);
    if (!credential || !rawCookie || rawCookie.includes(";") || !isCanonicalUuid(credential.sessionId)) throw new OperatorEligibilityBoundaryError("unauthorized");
    const declared = safe.get("content-length");
    if (declared !== undefined && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > OPERATOR_ELIGIBILITY_MAX_BODY_BYTES)) invalid();
    const bytes = await rawBody(request); if (bytes.byteLength === 0 || (declared !== undefined && Number(declared) !== bytes.byteLength)) invalid();
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid(); }
    const body = validateEligibilityMutationBody(new StrictJson(text).parse());
    return Object.freeze({ body, credential: Object.freeze({ sessionId: credential.sessionId, bearer: credential.bearer }), idempotencyKey: key });
  } catch (error) {
    if (error instanceof OperatorEligibilityBoundaryError) throw error;
    throw new OperatorEligibilityBoundaryError();
  }
}
