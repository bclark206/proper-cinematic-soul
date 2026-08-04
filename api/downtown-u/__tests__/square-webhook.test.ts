import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createSquareWebhookHandler,
  parseSquareEventEnvelope,
  SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES,
  type SquareWebhookClaim,
} from "../../../server/downtown-u/square-webhook";
import { createNodeSquareWebhookHandler } from "../square-webhook";

const signatureKey = "sandbox-signature-key";
const notificationUrl = "https://example.com/api/downtown-u/square-webhook";

function eventBody(type = "payment.updated", eventId = "event-123") {
  return Buffer.from(
    JSON.stringify({
      merchant_id: "merchant-sensitive",
      type,
      event_id: eventId,
      version: "2026-01-22",
      data: { object: { payment: { id: "payment-sensitive" } } },
    }),
  );
}

// This fixture deliberately implements Square's published algorithm directly,
// independently of production verification code.
function officialAlgorithmSignature(rawBody: Uint8Array, url = notificationUrl) {
  return createHmac("sha256", signatureKey)
    .update(Buffer.from(url, "utf8"))
    .update(rawBody)
    .digest("base64");
}

function request(
  rawBody = eventBody(),
  overrides: Partial<{
    method: string;
    headers: Record<string, string | string[] | undefined>;
  }> = {},
) {
  return {
    method: overrides.method ?? "POST",
    headers:
      overrides.headers ??
      ({
        "content-type": "application/json",
        "x-square-hmacsha256-signature": officialAlgorithmSignature(rawBody),
      } satisfies Record<string, string>),
    rawBody,
  };
}

function makeCore() {
  const processEvent = vi.fn<(claim: SquareWebhookClaim) => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    processEvent,
    handler: createSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    }),
  };
}

describe("Square webhook boundary", () => {
  it("accepts an independent fixed OpenSSL HMAC-SHA256 vector", async () => {
    const vectorUrl = "https://vector.example/api/downtown-u/square-webhook";
    const vectorKey = "independent-vector-key";
    const rawBody = Buffer.from(
      '{"event_id":"evt_vector-01","type":"payment.updated","version":"2026-01-22"}',
    );
    // Generated once outside Node and then hard-coded (URL and raw JSON are
    // concatenated with no separator), so this assertion cannot agree merely
    // because production and test share the same implementation:
    // printf '%s' 'https://vector.example/api/downtown-u/square-webhook{"event_id":"evt_vector-01","type":"payment.updated","version":"2026-01-22"}' | openssl dgst -sha256 -hmac 'independent-vector-key' -binary | openssl base64 -A
    const expectedSignature = "PNVgHU94o4LOvjNn04EknNjaEAcuIEE5EGWhwE9AB1o=";
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const handler = createSquareWebhookHandler({
      signatureKey: vectorKey,
      notificationUrl: vectorUrl,
      processEvent,
    });

    const result = await handler({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-square-hmacsha256-signature": expectedSignature,
      },
      rawBody,
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("accepts an official-algorithm signature and deterministically hashes exact bytes", async () => {
    const { handler, processEvent } = makeCore();
    const rawBody = eventBody();

    const first = await handler(request(rawBody));
    const second = await handler(request(rawBody));

    expect(first).toEqual({ status: 200, body: { ok: true } });
    expect(second.status).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(2);
    expect(processEvent.mock.calls[0][0]).toEqual({
      eventId: "event-123",
      eventType: "payment.updated",
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(processEvent.mock.calls[1][0].bodyHash).toBe(
      processEvent.mock.calls[0][0].bodyHash,
    );
    expect(Object.keys(processEvent.mock.calls[0][0]).sort()).toEqual([
      "bodyHash",
      "eventId",
      "eventType",
    ]);
  });

  it.each([
    ["missing", undefined],
    ["invalid", "not-base64-or-valid"],
  ])("rejects a %s signature before processing", async (_label, signature) => {
    const { handler, processEvent } = makeCore();
    const result = await handler(
      request(eventBody(), {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": signature,
        },
      }),
    );

    expect(result.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["trailing punctuation", (signature: string) => `${signature}!`],
    ["leading whitespace", (signature: string) => ` ${signature}`],
    [
      "embedded whitespace",
      (signature: string) => `${signature.slice(0, 8)}\n${signature.slice(8)}`,
    ],
    ["URL-safe alphabet", (signature: string) => `_${signature.slice(1)}`],
    ["missing padding", (signature: string) => signature.replace(/=+$/, "")],
    ["extra padding", (signature: string) => `${signature}=`],
    ["invalid length", (signature: string) => signature.slice(0, 5)],
  ])("rejects noncanonical Base64 with %s", async (_label, mutate) => {
    const { handler, processEvent } = makeCore();
    const rawBody = eventBody();
    const result = await handler(
      request(rawBody, {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": mutate(officialAlgorithmSignature(rawBody)),
        },
      }),
    );

    expect(result.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects signatures made for a different notification URL", async () => {
    const { handler, processEvent } = makeCore();
    const rawBody = eventBody();
    const result = await handler(
      request(rawBody, {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": officialAlgorithmSignature(
            rawBody,
            `${notificationUrl}/wrong`,
          ),
        },
      }),
    );

    expect(result.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects altered raw bytes rather than parsing and reserializing", async () => {
    const { handler, processEvent } = makeCore();
    const original = eventBody();
    const altered = Buffer.from(`${original.toString("utf8")} `);
    const result = await handler(
      request(altered, {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": officialAlgorithmSignature(original),
        },
      }),
    );

    expect(result.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("looks up the signature and content type headers case-insensitively", async () => {
    const { handler, processEvent } = makeCore();
    const rawBody = eventBody("refund.updated");
    const result = await handler(
      request(rawBody, {
        headers: {
          "Content-Type": "Application/JSON; Charset=UTF-8",
          "X-SqUaRe-HmAcShA256-SiGnAtUrE": officialAlgorithmSignature(rawBody),
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("enforces POST and JSON content type (with optional charset)", async () => {
    const { handler, processEvent } = makeCore();
    expect((await handler(request(eventBody(), { method: "GET" }))).status).toBe(405);
    expect(
      (
        await handler(
          request(eventBody(), {
            headers: {
              "content-type": "text/plain",
              "x-square-hmacsha256-signature": officialAlgorithmSignature(eventBody()),
            },
          }),
        )
      ).status,
    ).toBe(415);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and missing event identity fields after verification", async () => {
    const { handler, processEvent } = makeCore();
    const malformed = Buffer.from("{oops");
    const malformedResult = await handler(
      request(malformed, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-square-hmacsha256-signature": officialAlgorithmSignature(malformed),
        },
      }),
    );
    expect(malformedResult.status).toBe(400);

    for (const body of [
      { type: "payment.updated", version: "1" },
      { event_id: "e", version: "1" },
      { event_id: "e", type: "payment.updated" },
    ]) {
      const rawBody = Buffer.from(JSON.stringify(body));
      const result = await handler(
        request(rawBody, {
          headers: {
            "content-type": "application/json",
            "x-square-hmacsha256-signature": officialAlgorithmSignature(rawBody),
          },
        }),
      );
      expect(result.status).toBe(400);
    }
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("accepts a 128-character opaque event ID and rejects an over-limit ID", async () => {
    const { handler, processEvent } = makeCore();
    const acceptedId = `evt_${"A".repeat(124)}`;
    const accepted = await handler(request(eventBody("payment.updated", acceptedId)));
    const rejected = await handler(
      request(eventBody("payment.updated", `${acceptedId}x`)),
    );

    expect(accepted.status).toBe(200);
    expect(rejected).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(processEvent).toHaveBeenCalledOnce();
    expect(processEvent.mock.calls[0][0].eventId).toBe(acceptedId);
  });

  it.each(["   ", "event\n123", "event\u0000123", "event/123"])(
    "rejects an invalid event ID %j with no side effects",
    async (eventId) => {
      const { handler, processEvent } = makeCore();
      const rawBody = eventBody("payment.updated", eventId);

      const result = await handler(request(rawBody));

      expect(result).toEqual({ status: 400, body: { error: "invalid_request" } });
      expect(processEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["2000-02-29", 200],
    ["2024-02-29", 200],
    ["2025-02-29", 400],
    ["2026-04-31", 400],
    ["2026-13-01", 400],
    ["2026-1-01", 400],
    ["2026-01-01\n", 400],
  ])("validates Square's YYYY-MM-DD version %j", async (version, status) => {
    const { handler, processEvent } = makeCore();
    const rawBody = Buffer.from(
      JSON.stringify({ event_id: "event-123", type: "payment.updated", version }),
    );

    const result = await handler(request(rawBody));

    expect(result.status).toBe(status);
    expect(processEvent).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it("rejects an oversized or malformed event type before it can be ignored", async () => {
    const { handler, processEvent } = makeCore();

    for (const type of ["a".repeat(129), "customer.updated\n", "Customer Updated"]) {
      const rawBody = eventBody(type);
      const result = await handler(request(rawBody));
      expect(result).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("ignores unsupported events only after successful signature verification", async () => {
    const { handler, processEvent } = makeCore();
    const rawBody = eventBody("customer.updated");
    const valid = await handler(request(rawBody));
    const invalid = await handler(
      request(rawBody, {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": "invalid",
        },
      }),
    );

    expect(valid).toEqual({ status: 200, body: { ok: true, ignored: true } });
    expect(invalid.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("returns a generic retryable response when the processor fails", async () => {
    const processEvent = vi.fn().mockRejectedValue(new Error("PII and secret details"));
    const handler = createSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });

    const result = await handler(request());

    expect(result).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("PII");
    expect(JSON.stringify(result)).not.toContain(signatureKey);
  });
});

describe("Square envelope property safety", () => {
  const validEnvelope = {
    event_id: "event-123",
    type: "payment.updated",
    version: "2026-01-22",
  };

  it.each(["event_id", "type", "version"] as const)(
    "rejects an inherited %s field",
    (field) => {
      const inherited = Object.create({ [field]: validEnvelope[field] }) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(validEnvelope)) {
        if (key !== field) inherited[key] = value;
      }

      expect(parseSquareEventEnvelope(inherited)).toBeNull();
    },
  );

  it.each(["event_id", "type", "version"] as const)(
    "rejects an accessor %s field without invoking it",
    (field) => {
      const accessor = { ...validEnvelope };
      const getter = vi.fn(() => {
        throw new Error("accessor must not run");
      });
      Object.defineProperty(accessor, field, { get: getter, enumerable: true });

      expect(parseSquareEventEnvelope(accessor)).toBeNull();
      expect(getter).not.toHaveBeenCalled();
    },
  );
});

describe("Node/Vercel raw stream adapter", () => {
  function responseRecorder() {
    const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
      headers: {},
    };
    return {
      state,
      response: {
        status(code: number) {
          state.status = code;
          return {
            json(body: unknown) {
              state.body = body;
            },
          };
        },
        setHeader(name: string, value: string) {
          state.headers[name.toLowerCase()] = value;
        },
      },
    };
  }

  function streamRequest(rawBody: Buffer, extra: Record<string, unknown> = {}) {
    const stream = Readable.from([rawBody.subarray(0, 7), rawBody.subarray(7)]);
    return Object.assign(stream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-square-hmacsha256-signature": officialAlgorithmSignature(rawBody),
      },
      ...extra,
    });
  }

  it("reads the raw stream once and passes supported claims to the injected processor", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const rawBody = eventBody();
    const req = streamRequest(rawBody);
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state.status).toBe(200);
    expect(state.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(processEvent).toHaveBeenCalledOnce();
    expect((req as Readable).readableEnded).toBe(true);
  });

  it("accepts Uint8Array chunks without decoding them", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const rawBody = eventBody();
    const req = Object.assign(
      Readable.from([
        new Uint8Array(rawBody.subarray(0, 7)),
        new Uint8Array(rawBody.subarray(7)),
      ]),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": officialAlgorithmSignature(rawBody),
        },
      },
    );
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state).toMatchObject({ status: 200, body: { ok: true } });
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects a pre-parsed body instead of reconstructing JSON", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const req = streamRequest(eventBody(), { body: { event_id: "already-parsed" } });
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state.status).toBe(400);
    expect(state.body).toEqual({ error: "invalid_request" });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects a streaming body over 256 KiB before processing", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const oversized = Buffer.alloc(256 * 1024 + 1, 0x61);
    const req = streamRequest(oversized);
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state.status).toBe(413);
    expect(state.body).toEqual({ error: "payload_too_large" });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("accepts a valid signed JSON envelope at exactly 256 KiB", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const envelope = eventBody();
    const rawBody = Buffer.concat([
      envelope,
      Buffer.alloc(SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES - envelope.byteLength, 0x20),
    ]);
    expect(rawBody.byteLength).toBe(SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES);
    const req = streamRequest(rawBody);
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state).toMatchObject({ status: 200, body: { ok: true } });
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects an already-consumed stream with a generic response", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const req = streamRequest(eventBody());
    for await (const _chunk of req) {
      // Deliberately consume the request before it reaches the adapter.
    }
    expect(req.readableEnded).toBe(true);
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("returns a generic 400 when reading the async iterator fails", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const sensitiveFailure = "stream failed with signature key and customer PII";
    const req = Object.assign(
      {
        async *[Symbol.asyncIterator]() {
          yield eventBody().subarray(0, 5);
          throw new Error(sensitiveFailure);
        },
      },
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": officialAlgorithmSignature(eventBody()),
        },
      },
    );
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(JSON.stringify(state)).not.toContain(sensitiveFailure);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a string chunk", () => Readable.from([eventBody().toString("utf8")])],
    [
      "a decoded invalid-UTF-8 string",
      () => Readable.from([Buffer.from([0xff]).toString("utf8")]),
    ],
    ["an arbitrary chunk type", () => Readable.from([{ bytes: eventBody() }])],
  ])("rejects %s instead of reconstructing raw bytes", async (_label, makeStream) => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const adapter = createNodeSquareWebhookHandler({
      signatureKey,
      notificationUrl,
      processEvent,
    });
    const req = Object.assign(makeStream(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-square-hmacsha256-signature": officialAlgorithmSignature(eventBody()),
      },
    });
    const { response, state } = responseRecorder();

    await adapter(req, response);

    expect(state).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(processEvent).not.toHaveBeenCalled();
  });
});
