import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelReservation, getMe, getMeals, getPurchases, getReservations, logout, requestMagicLink, reserveMeal, sendCode, verifyCode,
  type DowntownUFetch,
} from "../api";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" }, ...init,
});
const key = "0123456789abcdef0123456789abcdef";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Downtown U browser request adapters", () => {
  it("bootstraps the HttpOnly session with a same-origin no-store GET", async () => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json({
      studentId: "11111111-1111-4111-8111-111111111111", email: null, phone: null,
      eligibilityStatus: "approved", availableCredits: 3, activePlan: null,
    }));
    await expect(getMe(fetcher)).resolves.toMatchObject({ availableCredits: 3 });
    expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/me", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("sends exact auth bodies without adding contact-derived fields", async () => {
    const fetcher = vi.fn<DowntownUFetch>()
      .mockResolvedValueOnce(json({ accepted: true }, { status: 202 }))
      .mockResolvedValueOnce(json({ accepted: true }, { status: 202 }))
      .mockResolvedValueOnce(json({ authenticated: true }));
    await requestMagicLink("student@example.test", fetcher);
    await sendCode("+14435550123", fetcher);
    await verifyCode("A".repeat(43), "123456", fetcher);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      ["/api/downtown-u/request-link", '{"email":"student@example.test"}'],
      ["/api/downtown-u/send-code", '{"phone":"+14435550123"}'],
      ["/api/downtown-u/verify-code", `{"challengeId":"${"A".repeat(43)}","verifier":"123456"}`],
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init).toEqual(expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
    }));
  });

  it("sends only server identifiers and reuses the caller-owned reservation key", async () => {
    const response = { id: "22222222-2222-4222-8222-222222222222", mealId: "meal-1", mealName: "Meal",
      modifiers: [], credits: 2, status: "reserved", reservedAt: "2026-08-05T12:00:00Z", expiresAt: "2026-08-05T12:15:00Z" };
    const fetcher = vi.fn<DowntownUFetch>().mockImplementation(async () => json(response, { status: 201 }));
    await reserveMeal({ mealId: "meal-1", modifierIds: ["mod-1"], idempotencyKey: key }, fetcher);
    await reserveMeal({ mealId: "meal-1", modifierIds: ["mod-1"], idempotencyKey: key }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init?.body).toBe(
      `{"mealId":"meal-1","modifierIds":["mod-1"],"idempotencyKey":"${key}"}`,
    );
  });

  it("uses a separate exact cancellation body and encodes only a validated UUID in the route", async () => {
    const response = { id: "22222222-2222-4222-8222-222222222222", mealId: "meal-1", mealName: "Meal",
      modifiers: [], credits: 2, status: "reversed", reservedAt: "2026-08-05T12:00:00Z", expiresAt: "2026-08-05T12:15:00Z", reversedAt: "2026-08-05T12:02:00Z" };
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json(response));
    await cancelReservation(response.id, key, fetcher);
    expect(fetcher).toHaveBeenCalledWith(`/api/downtown-u/reservations/${response.id}/cancel`, expect.objectContaining({
      body: `{"idempotencyKey":"${key}"}`,
    }));
  });

  it("paginates with opaque cursors via URLSearchParams and fixed limits", async () => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    await getPurchases("cursor.part", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/purchases?limit=25&cursor=cursor.part", expect.objectContaining({ method: "GET" }));
  });

  it("uses exact read URLs/options and enforces the public -19..20 modifier contract", async () => {
    const fetcher = vi.fn<DowntownUFetch>()
      .mockResolvedValueOnce(json({ items: [{ id: "meal-1", name: "Meal", baseCredits: 20,
        modifiers: [{ id: "credit", name: "Credit", creditDelta: -19 }, { id: "premium", name: "Premium", creditDelta: 20 }] }] }))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    await expect(getMeals(fetcher)).resolves.toMatchObject({ items: [{ modifiers: [{ creditDelta: -19 }, { creditDelta: 20 }] }] });
    await getReservations(null, fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/downtown-u/meals", "/api/downtown-u/reservations?limit=25",
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init).toEqual(expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    }));
  });

  it("rejects modifier credit deltas below the public -19 boundary", async () => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json({ items: [{ id: "meal-1", name: "Meal", baseCredits: 20,
      modifiers: [{ id: "credit", name: "Credit", creditDelta: -20 }] }] }));
    await expect(getMeals(fetcher)).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("accepts bodyless 204 logout and sends the exact empty object bytes", async () => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(logout(fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/logout", expect.objectContaining({ body: "{}" }));
  });

  it("rejects malformed, oversized, and wrongly typed successful JSON", async () => {
    const malformed = vi.fn<DowntownUFetch>().mockResolvedValue(new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(getMe(malformed)).rejects.toMatchObject({ kind: "invalid-response" });
    const oversized = vi.fn<DowntownUFetch>().mockResolvedValue(json({ x: "x".repeat(270_000) }));
    await expect(getMe(oversized)).rejects.toMatchObject({ kind: "invalid-response" });
    const wrong = vi.fn<DowntownUFetch>().mockResolvedValue(json({ availableCredits: "3" }));
    await expect(getMe(wrong)).rejects.toMatchObject({ kind: "invalid-response" });
    const contentLength = vi.fn<DowntownUFetch>().mockResolvedValue(new Response("{}", {
      status: 200, headers: { "Content-Type": "application/json", "Content-Length": "262145" },
    }));
    await expect(getMe(contentLength)).rejects.toMatchObject({ kind: "invalid-response" });
    const wrongType = vi.fn<DowntownUFetch>().mockResolvedValue(new Response("{}", {
      status: 200, headers: { "Content-Type": "text/html" },
    }));
    await expect(getMe(wrongType)).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("bounds real response streams by raw bytes and cancels overflow despite a dishonest length", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array([1])); },
      cancel() { canceled = true; },
    });
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(new Response(stream, {
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
    }));
    await expect(getMe(fetcher)).rejects.toMatchObject({ kind: "invalid-response" });
    expect(canceled).toBe(true);
  });

  it("fatally decodes UTF-8 while allowing a multibyte character split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ items: [{ id: "meal-1", name: "Café", baseCredits: 1, modifiers: [] }] }));
    const split = bytes.indexOf(0xc3);
    const validStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, split + 1)); controller.enqueue(bytes.slice(split + 1)); controller.close(); },
    });
    await expect(getMeals(vi.fn<DowntownUFetch>().mockResolvedValue(new Response(validStream, {
      headers: { "Content-Type": "application/json" },
    })))).resolves.toMatchObject({ items: [{ name: "Café" }] });

    const invalidStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([0x7b, 0x22, 0xc3, 0x22, 0x7d])); controller.close(); },
    });
    await expect(getMe(vi.fn<DowntownUFetch>().mockResolvedValue(new Response(invalidStream, {
      headers: { "Content-Type": "application/json" },
    })))).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("handles a null body safely and clears the request timer", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "Content-Type": "application/json" }), body: null,
    } as Response);
    await expect(getMe(fetcher)).rejects.toMatchObject({ kind: "invalid-response" });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("accepts 204 only for bodyless operations and always clears request timeouts", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const noContent = vi.fn<DowntownUFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(logout(noContent)).resolves.toBeUndefined();
    await expect(getMe(noContent)).rejects.toMatchObject({ kind: "invalid-response" });
    expect(clear).toHaveBeenCalledTimes(2);

    const hanging = vi.fn<DowntownUFetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const pending = expect(getMe(hanging)).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(clear).toHaveBeenCalledTimes(3);
  });

  it("rejects non-USD contract data before Intl can receive it", async () => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json({
      studentId: "11111111-1111-4111-8111-111111111111", email: null, phone: null,
      eligibilityStatus: "approved", availableCredits: 3,
      activePlan: { planId: "flex-5", creditsGranted: 5, priceCents: 6000, currency: "ZZZ", status: "paid", paidAt: "2026-08-01T12:00:00Z" },
    }));
    await expect(getMe(fetcher)).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it.each([
    [401, "unauthorized"], [403, "forbidden"], [404, "not-found"], [409, "insufficient-credits"],
    [429, "rate-limited"], [503, "unavailable"],
  ])("maps status %s to a bounded public error", async (status, kind) => {
    const fetcher = vi.fn<DowntownUFetch>().mockResolvedValue(json(
      { error: status === 409 ? "insufficient_credits" : "anything" },
      { status, headers: { "Content-Type": "application/json", "Retry-After": "600" } },
    ));
    await expect(reserveMeal({ mealId: "meal-1", modifierIds: [], idempotencyKey: key }, fetcher))
      .rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterSeconds: 600 } : {}) });
  });
});
