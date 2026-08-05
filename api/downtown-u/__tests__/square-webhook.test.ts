import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createSquareWebhookHandler,
  extractSquareWebhookResourceId,
  parseSquareEventEnvelope,
  SQUARE_WEBHOOK_MAX_RAW_BODY_BYTES,
  type SquareWebhookClaim,
} from "../../../server/downtown-u/square-webhook";
import { createNodeSquareWebhookHandler } from "../square-webhook";

const signatureKey = "sandbox-signature-key";
const notificationUrl = "https://example.com/api/downtown-u/square-webhook";

function eventBody(type = "payment.updated", eventId = "event-123") {
  const resourceType = type === "refund.updated" ? "refund" : type === "payment.updated" ? "payment" : "customer";
  const resourceId = `${resourceType}-sensitive`;
  const resource = { [resourceType]: { id: resourceId } };
  return Buffer.from(
    JSON.stringify({
      merchant_id: "merchant-sensitive",
      type,
      event_id: eventId,
      version: "2026-01-22",
      data: { type: resourceType, id: resourceId, object: resource },
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

type SupportedEventType = SquareWebhookClaim["eventType"];
type DescriptorLocatorCase = {
  label: string;
  arrange: (
    object: Record<string, unknown>,
    expectedKey: "payment" | "refund",
    oppositeKey: "payment" | "refund",
    resource: Record<string, string>,
  ) => { getter?: ReturnType<typeof vi.fn>; cleanup?: () => void };
};

function locatorEnvelope(type: SupportedEventType) {
  const expectedKey: "payment" | "refund" =
    type === "payment.updated" ? "payment" : "refund";
  const resourceId = type === "payment.updated" ? "PAY_1" : "REFUND_1";
  const resource = { id: resourceId };
  const oppositeKey: "payment" | "refund" =
    expectedKey === "payment" ? "refund" : "payment";
  return {
    expectedKey,
    oppositeKey,
    resource,
    envelope: {
      event_id: "event-123",
      type,
      version: "2026-01-22",
      data: {
        type: expectedKey,
        id: resourceId,
        object: { [expectedKey]: resource } as Record<string, unknown>,
      },
    },
  };
}

const descriptorLocatorCases: DescriptorLocatorCase[] = [
  {
    label: "opposite own undefined data property",
    arrange: (object, _expectedKey, oppositeKey) => {
      Object.defineProperty(object, oppositeKey, {
        configurable: true,
        enumerable: true,
        value: undefined,
      });
      return {};
    },
  },
  {
    label: "opposite own accessor",
    arrange: (object, _expectedKey, oppositeKey) => {
      const getter = vi.fn(() => {
        throw new Error("opposite accessor must not run");
      });
      Object.defineProperty(object, oppositeKey, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
      return { getter };
    },
  },
  {
    label: "opposite inherited data property",
    arrange: (_object, _expectedKey, oppositeKey, resource) => {
      Object.defineProperty(Object.prototype, oppositeKey, {
        configurable: true,
        value: resource,
      });
      return { cleanup: () => { Reflect.deleteProperty(Object.prototype, oppositeKey); } };
    },
  },
  {
    label: "opposite inherited accessor",
    arrange: (_object, _expectedKey, oppositeKey) => {
      const getter = vi.fn(() => {
        throw new Error("inherited opposite accessor must not run");
      });
      Object.defineProperty(Object.prototype, oppositeKey, {
        configurable: true,
        get: getter,
      });
      return {
        getter,
        cleanup: () => { Reflect.deleteProperty(Object.prototype, oppositeKey); },
      };
    },
  },
  {
    label: "expected own accessor",
    arrange: (object, expectedKey) => {
      const getter = vi.fn(() => {
        throw new Error("expected accessor must not run");
      });
      Object.defineProperty(object, expectedKey, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
      return { getter };
    },
  },
  {
    label: "inherited expected resource",
    arrange: (object, expectedKey, _oppositeKey, resource) => {
      delete object[expectedKey];
      Object.setPrototypeOf(object, { [expectedKey]: resource });
      return {};
    },
  },
  {
    label: "inherited expected accessor",
    arrange: (object, expectedKey) => {
      const getter = vi.fn(() => {
        throw new Error("inherited expected accessor must not run");
      });
      delete object[expectedKey];
      const prototype = {};
      Object.defineProperty(prototype, expectedKey, { get: getter });
      Object.setPrototypeOf(object, prototype);
      return { getter };
    },
  },
];

const descriptorLocatorMatrix = (["payment.updated", "refund.updated"] as const)
  .flatMap((type) => descriptorLocatorCases.map((testCase) => ({ type, ...testCase })));

describe("Square webhook boundary", () => {
  it("accepts an independent fixed OpenSSL HMAC-SHA256 vector", async () => {
    const vectorUrl = "https://vector.example/api/downtown-u/square-webhook";
    const vectorKey = "independent-vector-key";
    const rawBody = Buffer.from(
      '{"event_id":"evt_vector-01","type":"payment.updated","version":"2026-01-22","data":{"type":"payment","id":"PAY_VECTOR","object":{"payment":{"id":"PAY_VECTOR"}}}}',
    );
    // Generated once outside Node and then hard-coded (URL and raw JSON are
    // concatenated with no separator), so this assertion cannot agree merely
    // because production and test share the same implementation:
    // printf '%s' 'https://vector.example/api/downtown-u/square-webhook{"event_id":"evt_vector-01","type":"payment.updated","version":"2026-01-22","data":{"type":"payment","id":"PAY_VECTOR","object":{"payment":{"id":"PAY_VECTOR"}}}}' | openssl dgst -sha256 -hmac 'independent-vector-key' -binary | openssl base64 -A
    const expectedSignature = "i6DmAW6XATHA2wlD71xh7CNuyVxxI1wpTLL9/t40ydI=";
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
      resourceId: "payment-sensitive",
    });
    expect(processEvent.mock.calls[1][0].bodyHash).toBe(
      processEvent.mock.calls[0][0].bodyHash,
    );
    expect(Object.keys(processEvent.mock.calls[0][0]).sort()).toEqual([
      "bodyHash",
      "eventId",
      "eventType",
      "resourceId",
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
      JSON.stringify({ event_id: "event-123", type: "payment.updated", version, data: { type: "payment", id: "PAY_1", object: { payment: { id: "PAY_1" } } } }),
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

describe("Square webhook resource locator safety", () => {
  it.each([
    ["payment.updated", { data: { type: "payment", id: "PAY_1", object: { payment: { id: "PAY_1" } } } }, "PAY_1"],
    ["refund.updated", { data: { type: "refund", id: "REFUND_1", object: { refund: { id: "REFUND_1" } } } }, "REFUND_1"],
  ] as const)("extracts the published %s resource shape", (type, envelope, id) => {
    expect(extractSquareWebhookResourceId(envelope, type)).toBe(id);
  });

  it.each(descriptorLocatorMatrix)(
    "rejects $type with a $label directly without invoking getters",
    ({ type, arrange }) => {
      const { expectedKey, oppositeKey, resource, envelope } = locatorEnvelope(type);
      const { getter, cleanup } = arrange(
        envelope.data.object,
        expectedKey,
        oppositeKey,
        resource,
      );
      try {
        expect(extractSquareWebhookResourceId(envelope, type)).toBeNull();
        if (getter) expect(getter).not.toHaveBeenCalled();
      } finally {
        cleanup?.();
      }
    },
  );

  it.each(descriptorLocatorMatrix)(
    "rejects signed $type with a $label before processing",
    async ({ type, arrange }) => {
      const { handler, processEvent } = makeCore();
      const { expectedKey, oppositeKey, resource, envelope } = locatorEnvelope(type);
      const { getter, cleanup } = arrange(
        envelope.data.object,
        expectedKey,
        oppositeKey,
        resource,
      );
      const parse = vi.spyOn(JSON, "parse").mockReturnValue(envelope);
      try {
        const rawBody = eventBody(type);
        await expect(handler(request(rawBody))).resolves.toEqual({
          status: 400,
          body: { error: "invalid_request" },
        });
        if (getter) expect(getter).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
        cleanup?.();
      }
    },
  );

  it.each([
    ["missing nested object", { data: { type: "payment", id: "PAY_1", object: {} } }],
    ["missing data.type", { data: { id: "PAY_1", object: { payment: { id: "PAY_1" } } } }],
    ["missing data.id", { data: { type: "payment", object: { payment: { id: "PAY_1" } } } }],
    ["wrong data.type", { data: { type: "refund", id: "PAY_1", object: { payment: { id: "PAY_1" } } } }],
    ["malformed data.type", { data: { type: 1, id: "PAY_1", object: { payment: { id: "PAY_1" } } } }],
    ["malformed data.id", { data: { type: "payment", id: "PAY/1", object: { payment: { id: "PAY/1" } } } }],
    ["conflicting data.id", { data: { type: "payment", id: "PAY_2", object: { payment: { id: "PAY_1" } } } }],
    ["mismatched", { data: { type: "payment", id: "REFUND_1", object: { refund: { id: "REFUND_1" } } } }],
    ["ambiguous", { data: { type: "payment", id: "PAY_1", object: { payment: { id: "PAY_1" }, refund: { id: "REFUND_1" } } } }],
    ["oversized", { data: { type: "payment", id: "x".repeat(193), object: { payment: { id: "x".repeat(193) } } } }],
  ])("rejects a %s payment locator", (_label, envelope) => {
    expect(extractSquareWebhookResourceId(envelope, "payment.updated")).toBeNull();
  });

  it("rejects inherited and accessor containers/IDs without invoking getters", () => {
    const inherited = { data: { type: "payment", id: "PAY_1", object: Object.create({ payment: { id: "PAY_1" } }) } };
    expect(extractSquareWebhookResourceId(inherited, "payment.updated")).toBeNull();
    const getter = vi.fn(() => "PAY_1");
    const payment = {};
    Object.defineProperty(payment, "id", { get: getter, enumerable: true });
    expect(extractSquareWebhookResourceId({ data: { type: "payment", id: "PAY_1", object: { payment } } }, "payment.updated")).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["type", "id"] as const)("rejects inherited and accessor data.%s metadata without invoking getters", (field) => {
    const valid = { type: "payment", id: "PAY_1", object: { payment: { id: "PAY_1" } } };
    const inherited = Object.assign(Object.create({ [field]: valid[field] }), valid) as Record<string, unknown>;
    delete inherited[field];
    expect(extractSquareWebhookResourceId({ data: inherited }, "payment.updated")).toBeNull();

    const accessor = { ...valid };
    const getter = vi.fn(() => valid[field]);
    Object.defineProperty(accessor, field, { enumerable: true, get: getter });
    expect(extractSquareWebhookResourceId({ data: accessor }, "payment.updated")).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects signed supported events with invalid locator metadata before processing", async () => {
    const { handler, processEvent } = makeCore();
    const invalidData = [
      { id: "payment-sensitive", object: { payment: { id: "payment-sensitive" } } },
      { type: "refund", id: "payment-sensitive", object: { payment: { id: "payment-sensitive" } } },
      { type: "payment", id: "different", object: { payment: { id: "payment-sensitive" } } },
    ];
    for (const data of invalidData) {
      const rawBody = Buffer.from(JSON.stringify({ event_id: "event-123", type: "payment.updated", version: "2026-01-22", data }));
      await expect(handler(request(rawBody))).resolves.toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(processEvent).not.toHaveBeenCalled();
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
