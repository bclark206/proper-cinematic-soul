import { isUint8Array } from "node:util/types";
import {
  createSquareWebhookHandler,
  SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES,
  type SquareWebhookDependencies,
  type SquareWebhookResponse,
} from "../../server/downtown-u/square-webhook";

type NodeWebhookRequest = AsyncIterable<unknown> & {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  readableEnded?: boolean;
};

type NodeWebhookResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
};

// Vercel must not consume or parse the body before signature verification.
export const config = { api: { bodyParser: false } };

function send(response: NodeWebhookResponse, result: SquareWebhookResponse): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
  }
  response.status(result.status).json(result.body);
}

async function readRawBodyOnce(
  request: AsyncIterable<unknown>,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (!isUint8Array(chunk)) {
      throw new TypeError("Webhook stream yielded a non-byte chunk");
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    totalBytes += bytes.byteLength;
    if (totalBytes > SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES) return null;
    chunks.push(bytes);
  }

  return Buffer.concat(chunks, totalBytes);
}

/** Node/Vercel adapter. Body parsing must be disabled for this route. */
export function createNodeSquareWebhookHandler(dependencies: SquareWebhookDependencies) {
  const handle = createSquareWebhookHandler(dependencies);

  return async (
    request: NodeWebhookRequest,
    response: NodeWebhookResponse,
  ): Promise<void> => {
    if (request.body !== undefined || request.readableEnded) {
      send(response, { status: 400, body: { error: "invalid_request" } });
      return;
    }

    let rawBody: Buffer | null;
    try {
      rawBody = await readRawBodyOnce(request);
    } catch {
      send(response, { status: 400, body: { error: "invalid_request" } });
      return;
    }

    if (rawBody === null) {
      send(response, { status: 413, body: { error: "payload_too_large" } });
      return;
    }

    send(
      response,
      await handle({
        method: request.method,
        headers: request.headers,
        rawBody,
      }),
    );
  };
}

async function unavailableProcessor(): Promise<never> {
  // Phase 2 A1 establishes only the verified boundary. Retry supported events
  // until the durable event processor is added in a later task.
  throw new Error("Square webhook processor is not configured");
}

export default async function squareWebhook(
  request: NodeWebhookRequest,
  response: NodeWebhookResponse,
): Promise<void> {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.DOWNTOWN_U_SQUARE_WEBHOOK_URL;
  if (!signatureKey || !notificationUrl) {
    send(response, { status: 500, body: { error: "server_error" } });
    return;
  }

  return createNodeSquareWebhookHandler({
    signatureKey,
    notificationUrl,
    processEvent: unavailableProcessor,
  })(request, response);
}
