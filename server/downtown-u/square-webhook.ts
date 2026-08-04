import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WebhookEventConflictError } from "./webhook-event-store";

export const SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES = 256 * 1024;

const SUPPORTED_EVENT_TYPES = new Set(["payment.updated", "refund.updated"]);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const EVENT_TYPE_MAX_LENGTH = 128;
const VERSION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface SquareWebhookClaim {
  eventId: string;
  eventType: "payment.updated" | "refund.updated";
  bodyHash: string;
}

export interface SquareWebhookProcessResult {
  outcome: "accepted" | "duplicate";
}

export interface SquareWebhookDependencies {
  signatureKey: string;
  notificationUrl: string;
  processEvent: (claim: SquareWebhookClaim) => Promise<void | SquareWebhookProcessResult>;
}

export interface SquareWebhookRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Uint8Array;
}

export interface SquareWebhookResponse {
  status: number;
  body: Record<string, boolean | string>;
  headers?: Record<string, string>;
}

function header(
  headers: SquareWebhookRequest["headers"],
  wantedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === wantedName,
  );
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function signatureIsValid(
  rawBody: Uint8Array,
  suppliedSignature: string | undefined,
  signatureKey: string,
  notificationUrl: string,
): boolean {
  if (!suppliedSignature) return false;

  const expected = createHmac("sha256", signatureKey)
    .update(Buffer.from(notificationUrl, "utf8"))
    .update(rawBody)
    .digest();

  let supplied: Buffer;
  try {
    if (
      suppliedSignature.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        suppliedSignature,
      )
    ) {
      return false;
    }
    supplied = Buffer.from(suppliedSignature, "base64");
    if (supplied.toString("base64") !== suppliedSignature) return false;
  } catch {
    return false;
  }

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

interface SquareEventEnvelope {
  event_id: string;
  type: string;
  version: string;
}

function ownDataString(
  value: object,
  key: keyof SquareEventEnvelope,
): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function isValidCalendarVersion(version: string): boolean {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function parseSquareEventEnvelope(value: unknown): SquareEventEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const eventId = ownDataString(value, "event_id");
  const eventType = ownDataString(value, "type");
  const version = ownDataString(value, "version");
  if (
    eventId === null ||
    !EVENT_ID_PATTERN.test(eventId) ||
    eventType === null ||
    eventType.length > EVENT_TYPE_MAX_LENGTH ||
    !EVENT_TYPE_PATTERN.test(eventType) ||
    version === null ||
    !isValidCalendarVersion(version)
  ) {
    return null;
  }

  return { event_id: eventId, type: eventType, version };
}

/**
 * Framework-neutral webhook boundary. Signature verification deliberately
 * consumes the caller-provided original bytes before JSON parsing.
 */
export function createSquareWebhookHandler(dependencies: SquareWebhookDependencies) {
  return async (request: SquareWebhookRequest): Promise<SquareWebhookResponse> => {
    if (request.method?.toUpperCase() !== "POST") {
      return {
        status: 405,
        body: { error: "method_not_allowed" },
        headers: { Allow: "POST" },
      };
    }

    const contentType = header(request.headers, "content-type");
    if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
      return { status: 415, body: { error: "unsupported_media_type" } };
    }

    if (request.rawBody.byteLength > SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES) {
      return { status: 413, body: { error: "payload_too_large" } };
    }

    if (
      !signatureIsValid(
        request.rawBody,
        header(request.headers, "x-square-hmacsha256-signature"),
        dependencies.signatureKey,
        dependencies.notificationUrl,
      )
    ) {
      return { status: 401, body: { error: "unauthorized" } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(request.rawBody).toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_request" } };
    }

    const envelope = parseSquareEventEnvelope(parsed);
    if (!envelope) {
      return { status: 400, body: { error: "invalid_request" } };
    }

    if (!SUPPORTED_EVENT_TYPES.has(envelope.type)) {
      return { status: 200, body: { ok: true, ignored: true } };
    }

    const claim: SquareWebhookClaim = {
      eventId: envelope.event_id,
      eventType: envelope.type as SquareWebhookClaim["eventType"],
      bodyHash: createHash("sha256").update(request.rawBody).digest("hex"),
    };

    try {
      const result = await dependencies.processEvent(claim);
      if (result?.outcome === "accepted") {
        return { status: 202, body: { ok: true, accepted: true } };
      }
      if (result?.outcome === "duplicate") {
        return { status: 200, body: { ok: true, duplicate: true } };
      }
    } catch (error) {
      if (error instanceof WebhookEventConflictError) {
        return { status: 409, body: { error: "event_conflict" } };
      }
      return { status: 503, body: { error: "temporarily_unavailable" } };
    }

    return { status: 200, body: { ok: true } };
  };
}
