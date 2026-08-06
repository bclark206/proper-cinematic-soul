export const SQUARE_API_MAX_RESPONSE_BYTES = 1024 * 1024;
export const SQUARE_API_DEFAULT_TIMEOUT_MS = 8_000;
export const SQUARE_API_VERSION = "2026-01-22";
export const SQUARE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,192}$/;

export type SquareApiErrorKind = "configuration" | "permanent" | "transient";

/** A deliberately generic error: upstream bodies, URLs, tokens and PII never enter its message. */
export class SquareApiError extends Error {
  constructor(
    public readonly kind: SquareApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SquareApiError";
  }
}

export type SquareResource = Record<string, unknown>;

export interface SquareClient {
  readonly locationId: string;
  getPayment(id: string): Promise<SquareResource>;
  getOrder(id: string): Promise<SquareResource>;
  getRefund(id: string): Promise<SquareResource>;
}

export interface SquareCheckoutClient extends SquareClient {
  createOrder(body: SquareResource): Promise<SquareResource>;
  updateOrder(id: string, body: SquareResource): Promise<SquareResource>;
  createPayment(body: SquareResource): Promise<SquareResource>;
}

export interface SquareClientConfig {
  accessToken: string;
  apiVersion: string;
  locationId: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function validNonempty(value: string): boolean {
  return value.length > 0 && value === value.trim() && value.length <= 512;
}

function invalidConfig(): never {
  throw new SquareApiError("configuration", "Square API configuration is invalid");
}

type CancelBody = () => Promise<unknown>;

/**
 * Waits for cancellation while the request timeout remains armed. If a
 * non-cooperative stream never settles cancellation, the request abort is the
 * cleanup fallback. Cancellation errors are intentionally contained.
 */
async function cancelSafely(cancel: CancelBody, controller: AbortController): Promise<void> {
  const { signal } = controller;
  const cancellation = Promise.resolve().then(cancel).catch(() => {
    controller.abort();
  });
  if (signal.aborted) {
    await Promise.race([cancellation, Promise.resolve()]);
    return;
  }
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([cancellation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function rejectUnconsumed(response: Response, controller: AbortController, error: SquareApiError): Promise<never> {
  if (response.body) await cancelSafely(() => response.body!.cancel(), controller);
  throw error;
}

function validJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = /^\s*application\/json\s*/i.exec(value);
  if (!mediaType) return false;
  let remainder = value.slice(mediaType[0].length);
  const parameterNames = new Set<string>();
  const parameter = /^;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*")\s*/;
  while (remainder.length > 0) {
    const match = parameter.exec(remainder);
    if (!match) return false;
    const name = match[1].toLowerCase();
    if (parameterNames.has(name)) return false;
    parameterNames.add(name);
    remainder = remainder.slice(match[0].length);
  }
  return true;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    controller.abort();
    throw new SquareApiError("transient", "Square API temporarily unavailable");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await cancelSafely(() => reader.cancel(), controller);
        throw new SquareApiError("permanent", "Invalid response from Square API");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SquareApiError) throw error;
    await cancelSafely(() => reader.cancel(), controller);
    throw new SquareApiError("transient", "Square API temporarily unavailable");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SquareApiError("permanent", "Invalid response from Square API");
  }
}

export function createSquareClient(config: SquareClientConfig): SquareCheckoutClient {
  const timeoutMs = config.timeoutMs ?? SQUARE_API_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? SQUARE_API_MAX_RESPONSE_BYTES;
  const baseUrl = config.baseUrl ?? "https://connect.squareup.com";
  if (
    !validNonempty(config.accessToken) ||
    config.apiVersion !== SQUARE_API_VERSION ||
    !SQUARE_RESOURCE_ID_PATTERN.test(config.locationId) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4 * 1024 * 1024
  ) invalidConfig();

  let origin: string;
  try {
    const parsed = new URL(baseUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalidConfig();
    origin = parsed.href.replace(/\/$/, "");
  } catch (error) {
    if (error instanceof SquareApiError) throw error;
    invalidConfig();
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") invalidConfig();

  async function requestResource(method: "GET" | "POST" | "PUT", path: string, wrapper: string, body?: SquareResource): Promise<SquareResource> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let result: Response;
      try {
        result = await fetchImpl(`${origin}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Square-Version": config.apiVersion,
            Accept: "application/json",
            ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch {
        throw new SquareApiError("transient", "Square API temporarily unavailable");
      }

      if (!result.ok) {
        const transient = result.status === 408 || result.status === 429 || result.status >= 500;
        await rejectUnconsumed(result, controller, new SquareApiError(
          transient ? "transient" : "permanent",
          transient ? "Square API temporarily unavailable" : "Square resource is unavailable",
          result.status,
        ));
      }
      const declaredLength = result.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes)) {
        await rejectUnconsumed(result, controller, new SquareApiError("permanent", "Invalid response from Square API"));
      }
      if (!validJsonContentType(result.headers.get("content-type"))) {
        await rejectUnconsumed(result, controller, new SquareApiError("permanent", "Invalid response from Square API"));
      }
      const text = await readBoundedBody(result, maxResponseBytes, controller);
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch { throw new SquareApiError("permanent", "Invalid response from Square API"); }
      if (!plainObject(parsed)) throw new SquareApiError("permanent", "Invalid response from Square API");
      const resource = ownData(parsed, wrapper);
      if (!plainObject(resource)) throw new SquareApiError("permanent", "Invalid response from Square API");
      return resource;
    } finally { clearTimeout(timer); }
  }

  function getResource(path: string, wrapper: string, id: string): Promise<SquareResource> {
    if (!SQUARE_RESOURCE_ID_PATTERN.test(id)) return Promise.reject(new SquareApiError("permanent", "Invalid Square resource identifier"));
    return requestResource("GET", `${path}${encodeURIComponent(id)}`, wrapper);
  }

  return {
    locationId: config.locationId,
    getPayment: (id) => getResource("/v2/payments/", "payment", id),
    getOrder: (id) => getResource("/v2/orders/", "order", id),
    getRefund: (id) => getResource("/v2/refunds/", "refund", id),
    createOrder: (body) => requestResource("POST", "/v2/orders", "order", body),
    updateOrder: (id, body) => {
      if (!SQUARE_RESOURCE_ID_PATTERN.test(id)) return Promise.reject(new SquareApiError("permanent", "Invalid Square resource identifier"));
      return requestResource("PUT", `/v2/orders/${encodeURIComponent(id)}`, "order", body);
    },
    createPayment: (body) => requestResource("POST", "/v2/payments", "payment", body),
  };
}

export function createSquareClientFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): SquareCheckoutClient {
  return createSquareClient({
    accessToken: env.SQUARE_ACCESS_TOKEN ?? "",
    apiVersion: env.SQUARE_API_VERSION ?? "",
    locationId: env.SQUARE_LOCATION_ID ?? "",
    fetchImpl,
  });
}
