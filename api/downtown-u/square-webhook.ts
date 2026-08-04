import { isUint8Array } from "node:util/types";
import { Pool } from "pg";
import { PostgresWebhookEventStore } from "../../server/downtown-u/postgres-webhook-event-store";
import type { WebhookEventStore } from "../../server/downtown-u/webhook-event-store";
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

export function createClaimingProcessor(
  store: WebhookEventStore,
  processClaim?: (
    claim: Parameters<SquareWebhookDependencies["processEvent"]>[0] & {
      claimToken: string;
      attemptCount: number;
    },
    acknowledgment: {
      complete(): Promise<void>;
      fail(failureCode: string, failureDetail: string): Promise<void>;
    },
  ) => Promise<void>,
): SquareWebhookDependencies["processEvent"] {
  return async (claim) => {
    const result = await store.claim(claim.eventId, claim.eventType, claim.bodyHash);
    if (result.outcome === "claimed") {
      if (processClaim) {
        let disposition: "processing" | "completed" | "failed" = "processing";
        const ensureProcessing = () => {
          if (disposition !== "processing") throw new Error("Webhook claim was already acknowledged");
        };
        await processClaim(
          { ...claim, claimToken: result.claimToken, attemptCount: result.attemptCount },
          {
            complete: async () => {
              ensureProcessing();
              await store.complete(claim.eventId, result.claimToken);
              disposition = "completed";
            },
            fail: async (failureCode, failureDetail) => {
              ensureProcessing();
              await store.fail(claim.eventId, result.claimToken, failureCode, failureDetail);
              disposition = "failed";
            },
          },
        );
        if ((disposition as string) === "completed") return { outcome: "accepted" };
        throw new Error("Webhook claim was not completed");
      }
      try {
        await store.fail(claim.eventId, result.claimToken, "processor_unavailable", "Webhook processor unavailable");
      } catch {
        // Still return a retryable response if acknowledgment recovery fails.
      }
      throw new Error("Webhook processor unavailable");
    }
    if (result.outcome === "duplicate") return { outcome: "duplicate" };
    throw new Error("Webhook event is not currently processable");
  };
}

let webhookPool: Pool | undefined;
function getWebhookPool(connectionString: string): Pool {
  webhookPool ??= new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  return webhookPool;
}

export default async function squareWebhook(
  request: NodeWebhookRequest,
  response: NodeWebhookResponse,
): Promise<void> {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.DOWNTOWN_U_SQUARE_WEBHOOK_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!signatureKey || !notificationUrl || !databaseUrl) {
    send(response, { status: 503, body: { error: "temporarily_unavailable" } });
    return;
  }

  return createNodeSquareWebhookHandler({
    signatureKey,
    notificationUrl,
    processEvent: createClaimingProcessor(
      new PostgresWebhookEventStore(getWebhookPool(databaseUrl)),
    ),
  })(request, response);
}
