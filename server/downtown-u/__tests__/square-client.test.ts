import { describe, expect, it, vi } from "vitest";
import { createSquareClient, SquareApiError } from "../square-client";

const config = {
  accessToken: "square-secret-token",
  apiVersion: "2026-01-22",
  locationId: "LOC_1",
};

type StreamCancel = (reason?: unknown) => void | PromiseLike<void>;

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamingResponse(
  {
    status = 200,
    headers = { "content-type": "application/json" },
    chunks = [],
    endless = false,
    cancelImpl = () => Promise.resolve(),
  }: {
    status?: number;
    headers?: Record<string, string>;
    chunks?: string[];
    endless?: boolean;
    cancelImpl?: StreamCancel;
  } = {},
) {
  const cancel = vi.fn<StreamCancel>(cancelImpl);
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const next = chunks.shift();
    if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
    else if (!endless) controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { result: new Response(body, { status, headers }), cancel, pull };
}

describe("Square API client", () => {
  it.each([
    ["getPayment", "pay_1", "/v2/payments/pay_1", "payment"],
    ["getOrder", "order-1", "/v2/orders/order-1", "order"],
    ["getRefund", "refund_1", "/v2/refunds/refund_1", "refund"],
  ] as const)("%s fetches the authoritative wrapped resource", async (method, id, path, key) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ [key]: { id } }));
    const client = createSquareClient({ ...config, fetchImpl });

    await expect(client[method](id)).resolves.toEqual({ id });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://connect.squareup.com${path}`,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Square-Version": config.apiVersion,
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(["", "../secret", "id?token=private", "x".repeat(193)])(
    "rejects invalid resource ID %j before fetch",
    async (id) => {
      const fetchImpl = vi.fn();
      await expect(createSquareClient({ ...config, fetchImpl }).getPayment(id)).rejects.toMatchObject({
        kind: "permanent",
        message: "Invalid Square resource identifier",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, "permanent"],
    [407, "permanent"],
    [408, "transient"],
    [409, "permanent"],
    [428, "permanent"],
    [429, "transient"],
    [499, "permanent"],
    [500, "transient"],
    [503, "transient"],
    [599, "transient"],
  ])("classifies HTTP %i as %s without leaking upstream data", async (status, kind) => {
    const privateText = "buyer@example.com token=very-secret";
    const fetchImpl = vi.fn().mockResolvedValue(response(privateText, status));
    const promise = createSquareClient({ ...config, fetchImpl }).getPayment("pay_1");
    await expect(promise).rejects.toMatchObject({ kind });
    await expect(promise).rejects.not.toThrow(privateText);
  });

  it.each([
    ["non-success status", { status: 404 }],
    ["invalid Content-Length", { headers: { "content-type": "application/json", "content-length": "secret" } }],
    ["oversized Content-Length", { headers: { "content-type": "application/json", "content-length": "1048577" } }],
    ["missing Content-Type", { headers: {} }],
    ["wrong Content-Type", { headers: { "content-type": "text/plain" } }],
    ["duplicated Content-Type", { headers: { "content-type": "application/json, application/json" } }],
    ["malformed Content-Type", { headers: { "content-type": "application/json; charset" } }],
  ])("cancels an unconsumed streaming body for %s", async (_label, options) => {
    const streamed = streamingResponse({ ...options, chunks: ["buyer@example.com token=secret"], endless: true });
    const promise = createSquareClient({ ...config, fetchImpl: vi.fn().mockResolvedValue(streamed.result) }).getPayment("pay_1");
    await expect(promise).rejects.toBeInstanceOf(SquareApiError);
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(streamed.pull).not.toHaveBeenCalled();
    await expect(promise).rejects.not.toThrow(/buyer@example\.com|token=secret/);
  });

  it.each([
    "application/json",
    "Application/JSON",
    " application/json ; charset=utf-8 ",
    "application/json;charset=\"utf-8\"; profile=trusted",
  ])("accepts a single valid JSON Content-Type: %s", async (contentType) => {
    const streamed = streamingResponse({
      headers: { "content-type": contentType },
      chunks: [JSON.stringify({ payment: { id: "pay_1" } })],
    });
    await expect(createSquareClient({ ...config, fetchImpl: vi.fn().mockResolvedValue(streamed.result) }).getPayment("pay_1"))
      .resolves.toEqual({ id: "pay_1" });
    expect(streamed.cancel).not.toHaveBeenCalled();
  });

  it("keeps timeout protection active until slow cancellation completes", async () => {
    let finishCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => { finishCancel = resolve; });
    const streamed = streamingResponse({ status: 404, endless: true });
    const cancel = vi.spyOn(streamed.result.body!, "cancel").mockImplementation(() => cancellation);
    const fetchImpl = vi.fn().mockResolvedValue(streamed.result);
    const promise = createSquareClient({ ...config, fetchImpl, timeoutMs: 10 }).getPayment("pay_1");
    const settled = promise.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    const signal = fetchImpl.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);
    await expect(settled).resolves.toMatchObject({ kind: "permanent", status: 404 });
    finishCancel();
  });

  it("does not let cancellation failure replace or expose the primary error", async () => {
    const streamed = streamingResponse({
      status: 404,
      endless: true,
    });
    const cancel = vi.spyOn(streamed.result.body!, "cancel").mockRejectedValue(
      new Error("buyer@example.com token=secret"),
    );
    const fetchImpl = vi.fn().mockResolvedValue(streamed.result);
    const error = await createSquareClient({ ...config, fetchImpl })
      .getPayment("pay_1").catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: "permanent", status: 404, message: "Square resource is unavailable" });
    expect((error as Error).message).not.toMatch(/buyer@example\.com|token=secret/);
    expect(cancel).toHaveBeenCalledOnce();
    expect((fetchImpl.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it.each(["missing Content-Type", "body reader setup"])("aborts safely when cleanup cannot cancel: %s", async (scenario) => {
    const streamed = streamingResponse({
      headers: scenario === "missing Content-Type" ? {} : { "content-type": "application/json" },
      endless: true,
    });
    const lock = streamed.result.body!.getReader();
    const fetchImpl = vi.fn().mockResolvedValue(streamed.result);
    const error = await createSquareClient({ ...config, fetchImpl }).getPayment("pay_1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SquareApiError);
    expect(error).toMatchObject({
      kind: scenario === "missing Content-Type" ? "permanent" : "transient",
      message: scenario === "missing Content-Type" ? "Invalid response from Square API" : "Square API temporarily unavailable",
    });
    expect((fetchImpl.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect(streamed.pull).not.toHaveBeenCalled();
    lock.releaseLock();
  });

  it("classifies network and timeout failures as transient generic errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("private host and buyer@example.com"));
    const error = await createSquareClient({ ...config, fetchImpl }).getOrder("order_1").catch((value) => value);
    expect(error).toBeInstanceOf(SquareApiError);
    expect(error).toMatchObject({ kind: "transient", message: "Square API temporarily unavailable" });
    expect(error.message).not.toContain("buyer@example.com");
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong wrapper", JSON.stringify({ payments: [] })],
    ["non-object resource", JSON.stringify({ payment: "private" })],
  ])("rejects %s with a generic permanent upstream error", async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(body));
    await expect(createSquareClient({ ...config, fetchImpl }).getPayment("pay_1")).rejects.toMatchObject({
      kind: "permanent",
      message: "Invalid response from Square API",
    });
  });

  it("rejects declared and actual oversized responses", async () => {
    const declared = vi.fn().mockResolvedValue(response("{}", 200, { "content-length": "1048577" }));
    await expect(createSquareClient({ ...config, fetchImpl: declared }).getPayment("pay_1")).rejects.toThrow(
      "Invalid response from Square API",
    );
    const actual = vi.fn().mockResolvedValue(response(`{"payment":{"id":"${"x".repeat(1_048_577)}"}}`));
    await expect(createSquareClient({ ...config, fetchImpl: actual }).getPayment("pay_1")).rejects.toThrow(
      "Invalid response from Square API",
    );
  });

  it("cancels an endless chunked response as soon as its actual body exceeds the limit", async () => {
    const streamed = streamingResponse({ chunks: ["12345", "67890"], endless: true });
    await expect(createSquareClient({
      ...config,
      fetchImpl: vi.fn().mockResolvedValue(streamed.result),
      maxResponseBytes: 8,
    }).getPayment("pay_1")).rejects.toMatchObject({ kind: "permanent", message: "Invalid response from Square API" });
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(streamed.pull).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["accessToken", ""],
    ["apiVersion", ""],
    ["locationId", ""],
    ["apiVersion", "not-a-version"],
  ] as const)("fails closed for invalid %s", (field, value) => {
    expect(() => createSquareClient({ ...config, [field]: value, fetchImpl: vi.fn() })).toThrow(
      "Square API configuration is invalid",
    );
  });
});
