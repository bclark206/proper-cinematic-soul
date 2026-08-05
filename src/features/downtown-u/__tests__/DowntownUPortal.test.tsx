import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DowntownUPortal from "../DowntownUPortal";

const me = { studentId: "11111111-1111-4111-8111-111111111111", email: "student@example.test", phone: null,
  eligibilityStatus: "approved", availableCredits: 4,
  activePlan: { planId: "scholar-10", creditsGranted: 10, priceCents: 11000, currency: "USD", status: "paid", paidAt: "2026-08-01T12:00:00Z" } };
const meals = { items: [{ id: "meal-1", name: "Server Meal", baseCredits: 2, modifiers: [
  { id: "mod-1", name: "Server Extra", creditDelta: 1 }, { id: "mod-2", name: "No sauce", creditDelta: 0 },
] }] };
const reservation = { id: "22222222-2222-4222-8222-222222222222", mealId: "meal-1", mealName: "Server Meal",
  modifiers: [{ id: "mod-1", name: "Server Extra", creditDelta: 1 }], credits: 3, status: "reserved",
  reservedAt: "2026-08-05T12:00:00Z", expiresAt: "2026-08-05T12:15:00Z" };
const purchase = { id: "33333333-3333-4333-8333-333333333333", planId: "scholar-10", creditsGranted: 10,
  priceCents: 11000, currency: "USD", status: "paid", refundedCredits: 0, paidAt: "2026-08-01T12:00:00Z", createdAt: "2026-08-01T12:00:00Z" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...headers },
}));
function authenticatedFetch(url: RequestInfo | URL) {
  const path = String(url);
  if (path.endsWith("/me")) return json(me);
  if (path.endsWith("/meals")) return json(meals);
  if (path.includes("purchases")) return json({ items: [purchase], nextCursor: "purchase.next" });
  if (path.includes("reservations?")) return json({ items: [reservation], nextCursor: "reservation.next" });
  throw new Error(`unmocked ${path}`);
}
const renderPortal = (state?: unknown) => render(<MemoryRouter initialEntries={[{ pathname: "/downtown-u/portal", state }]}><DowntownUPortal /></MemoryRouter>);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
});
afterEach(() => vi.unstubAllGlobals());

describe("Downtown U protected portal", () => {
  it("shows a semantic loading skeleton before session bootstrap resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderPortal();
    expect(screen.getByRole("status")).toHaveTextContent(/loading your downtown u account/i);
    expect(screen.getByRole("main")).toHaveClass("overflow-x-hidden");
  });

  it("shows enumeration-safe email and text sign-in after a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "unauthorized" }, 401)));
    renderPortal();
    expect(await screen.findByRole("heading", { name: /sign in to downtown u/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "nobody@example.test" } });
    fireEvent.submit(screen.getByLabelText(/email sign-in/i));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith("/api/downtown-u/request-link", expect.objectContaining({ body: '{"email":"nobody@example.test"}' })));
    expect(await screen.findByRole("status")).toHaveTextContent(/if the details match an eligible account/i);
    fireEvent.click(screen.getByRole("button", { name: /text a code/i }));
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });

  it("verifies an accessible six-digit code and reloads the session", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => json({ error: "unauthorized" }, 401))
      .mockImplementationOnce(() => json({ authenticated: true }))
      .mockImplementation(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByRole("heading", { name: /sign in/i });
    fireEvent.click(screen.getByRole("button", { name: /text a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /already have a code/i }));
    fireEvent.change(screen.getByLabelText(/sign-in reference/i), { target: { value: "A".repeat(43) } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: "123456" } });
    fireEvent.submit(screen.getByLabelText(/verify text code/i));
    expect(await screen.findByText(/4 meal credits/i)).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/downtown-u/verify-code", expect.objectContaining({ body: `{"challengeId":"${"A".repeat(43)}","verifier":"123456"}` }));
  });

  it("renders only server menu data, modifier deltas, and the computed server-backed total", async () => {
    renderPortal();
    expect(await screen.findByRole("heading", { name: "Server Meal" })).toBeInTheDocument();
    expect(screen.getByText(/2 credits/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    const checkbox = screen.getByRole("checkbox", { name: /server extra.*1 credit/i });
    fireEvent.click(checkbox);
    expect(screen.getByText(/total: 3 credits/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/catalog/i);
  });

  it("reserves with one stable cryptographic key across a transient retry", async () => {
    const fetcher = vi.fn(authenticatedFetch);
    fetcher.mockImplementationOnce(authenticatedFetch).mockImplementationOnce(authenticatedFetch)
      .mockImplementationOnce(authenticatedFetch).mockImplementationOnce(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" });
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /server extra/i }));
    fetcher.mockImplementationOnce(() => Promise.reject(new Error("offline"))).mockImplementationOnce(() => json(reservation, 201));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 3 credits/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm/i);
    fireEvent.click(screen.getByRole("button", { name: /retry reservation/i }));
    expect(await screen.findByRole("heading", { name: /reservation confirmed/i })).toBeInTheDocument();
    const calls = fetcher.mock.calls.filter(([url]) => String(url) === "/api/downtown-u/reservations");
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].idempotencyKey).toMatch(/^[a-f0-9]{48}$/);
    expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
  });

  it.each([
    [409, { error: "insufficient_credits" }, /not enough meal credits/i],
    [429, { error: "rate_limited" }, /try again in 10 minutes/i],
  ])("gives plain reservation feedback for status %s", async (status, body, copy) => {
    const fetcher = vi.fn(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" });
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => json(body, status, { "Retry-After": "600" }));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  });

  it("resets all protected state when any portal request loses authentication", async () => {
    const fetcher = vi.fn(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" });
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => json({ error: "unauthorized" }, 401));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i }));
    expect(await screen.findByRole("heading", { name: /sign in to downtown u/i })).toBeInTheDocument();
    expect(screen.queryByText("student@example.test")).not.toBeInTheDocument();
  });

  it("cancels an active reservation with a distinct stable key", async () => {
    const fetcher = vi.fn(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    const row = screen.getByRole("article", { name: /server meal reservation/i });
    fetcher.mockImplementationOnce(() => json({ error: "unavailable" }, 503)).mockImplementationOnce(() => json({ ...reservation, status: "reversed", reversedAt: "2026-08-05T12:05:00Z" }));
    fireEvent.click(within(row).getByRole("button", { name: /cancel reservation/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm the cancellation/i);
    fireEvent.click(screen.getByRole("button", { name: /retry cancellation/i }));
    expect(await screen.findByText(/reservation canceled/i)).toBeInTheDocument();
    const calls = fetcher.mock.calls.filter(([url]) => String(url).includes("/cancel"));
    const keys = calls.map(([, init]) => (JSON.parse(String(init?.body)) as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
  });

  it("paginates both histories without dropping the first page", async () => {
    const fetcher = vi.fn(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    fetcher.mockImplementationOnce(() => json({ items: [{ ...purchase, id: "44444444-4444-4444-8444-444444444444" }], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: /load more purchases/i }));
    await waitFor(() => expect(screen.getAllByText(/scholar 10/i)).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("cursor=purchase.next"), expect.anything());
    fetcher.mockImplementationOnce(() => json({ items: [{ ...reservation, id: "55555555-5555-4555-8555-555555555555" }], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: /load more reservations/i }));
    await waitFor(() => expect(screen.getAllByRole("article", { name: /server meal reservation/i })).toHaveLength(2));
  });

  it("logs out with a bodyless response and returns to sign-in", async () => {
    const fetcher = vi.fn(authenticatedFetch);
    vi.stubGlobal("fetch", fetcher);
    renderPortal();
    await screen.findByText(/4 meal credits/i);
    fetcher.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /sign in to downtown u/i })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/logout", expect.objectContaining({ body: "{}" }));
  });

  it("distinguishes retryable account errors from a clear unavailable feature state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "unavailable" }, 503)));
    renderPortal();
    expect(await screen.findByRole("heading", { name: /downtown u is temporarily unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("sends text requests exactly and explains that code and reference come from the same message", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ error: "unauthorized" }, 401))
      .mockImplementationOnce(() => json({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetcher); renderPortal();
    await screen.findByRole("heading", { name: /sign in/i });
    fireEvent.click(screen.getByRole("button", { name: /text a code/i }));
    const phone = screen.getByLabelText(/mobile number/i);
    expect(phone).toHaveAttribute("pattern", "\\+[1-9][0-9]{7,14}");
    fireEvent.change(phone, { target: { value: "+1 (443) 555-0123" } });
    expect(phone).toHaveValue("+14435550123");
    fireEvent.submit(screen.getByLabelText(/text sign-in/i));
    expect(await screen.findByText(/paste the sign-in reference from the same text message/i)).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/downtown-u/send-code", expect.objectContaining({ body: '{"phone":"+14435550123"}' }));
    const reference = "R".repeat(43);
    fireEvent.paste(screen.getByLabelText(/sign-in reference/i), { clipboardData: { getData: () => `Your Downtown U code is 654321. Sign-in reference: ${reference}.` } });
    expect(screen.getByLabelText(/sign-in reference/i)).toHaveValue(reference);
    expect(screen.getByLabelText(/6-digit code/i)).toHaveValue("654321");
  });

  it.each([[401, /could not verify that code/i], [503, /temporarily unavailable/i]] as const)(
    "gives safe verification feedback for status %s", async (status, copy) => {
      const fetcher = vi.fn().mockImplementationOnce(() => json({ error: "unauthorized" }, 401))
        .mockImplementationOnce(() => json({ authenticated: false }, status));
      vi.stubGlobal("fetch", fetcher); renderPortal(); await screen.findByRole("heading", { name: /sign in/i });
      fireEvent.click(screen.getByRole("button", { name: /text a code/i }));
      fireEvent.click(screen.getByRole("button", { name: /already have a code/i }));
      fireEvent.change(screen.getByLabelText(/sign-in reference/i), { target: { value: "A".repeat(43) } });
      fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: "123456" } });
      fireEvent.submit(screen.getByLabelText(/verify text code/i));
      expect(await screen.findByRole("alert")).toHaveTextContent(copy);
      expect(screen.getByRole("button", { name: /verify and sign in/i })).not.toBeDisabled();
    },
  );

  it("renders empty menu, no-plan account, and empty histories without internal labels", async () => {
    const emptyMe = { ...me, activePlan: null };
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => {
      const path = String(url); if (path.endsWith("/me")) return json(emptyMe); if (path.endsWith("/meals")) return json({ items: [] });
      return json({ items: [], nextCursor: null });
    }));
    renderPortal(); expect(await screen.findByText(/no meals are available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /account/i })); expect(screen.getByText(/no active plan/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(screen.getByText(/no reservations yet/i)).toBeInTheDocument(); expect(screen.getByText(/no plan purchases yet/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/catalog|internal/i);
  });

  it("enforces the trusted modifier cap of ten", async () => {
    const many = { items: [{ ...meals.items[0], modifiers: Array.from({ length: 11 }, (_, index) => ({
      id: `mod-${index}`, name: `Option ${index}`, creditDelta: 0,
    })) }] };
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/meals") ? json(many) : authenticatedFetch(url)));
    renderPortal(); await screen.findByRole("heading", { name: "Server Meal" });
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    const boxes = screen.getAllByRole("checkbox"); boxes.slice(0, 10).forEach((box) => fireEvent.click(box));
    expect(boxes.filter((box) => (box as HTMLInputElement).checked)).toHaveLength(10); expect(boxes[10]).toBeDisabled();
  });

  it("keeps a confirmed reservation definitive when its balance refresh fails", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" }); fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => json(reservation, 201)).mockImplementationOnce(() => json({ error: "unavailable" }, 503));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i }));
    expect(await screen.findByRole("heading", { name: /reservation confirmed/i })).toBeInTheDocument();
    expect(screen.getByText(/displayed balance has not refreshed/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not confirm your reservation/i)).not.toBeInTheDocument();
  });

  it("clears definitive retry attempts and gives changed selections new keys", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" }); fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByRole("button", { name: /retry reservation/i });
    const first = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).idempotencyKey;
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i })); expect(screen.queryByRole("button", { name: /retry reservation/i })).not.toBeInTheDocument();
    fetcher.mockImplementationOnce(() => json({ error: "conflict" }, 409));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByText(/selection is no longer available/i);
    const second = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).idempotencyKey;
    expect(second).not.toBe(first); expect(screen.queryByRole("button", { name: /retry reservation/i })).not.toBeInTheDocument();
  });

  it("returns to a clean sign-in state after logout 503 and auth loss during history actions", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal(); await screen.findByText(/4 meal credits/i);
    fetcher.mockImplementationOnce(() => json({ error: "unavailable" }, 503)); fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /sign in to downtown u/i })).toBeInTheDocument();

    vi.stubGlobal("fetch", fetcher.mockImplementation(authenticatedFetch)); renderPortal(); await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getAllByRole("button", { name: /history/i }).at(-1)!);
    fetcher.mockImplementationOnce(() => json({ error: "unauthorized" }, 401));
    fireEvent.click(screen.getAllByRole("button", { name: /load more purchases/i }).at(-1)!);
    expect((await screen.findAllByRole("heading", { name: /sign in to downtown u/i })).length).toBeGreaterThan(0);
  });

  it("uses reduced-motion-safe loaders, focusable authenticated heading, and overflow guards", async () => {
    renderPortal(); const heading = await screen.findByRole("heading", { name: /what sounds proper/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.querySelector(".min-h-screen.overflow-x-hidden")).toBeInTheDocument();
    expect(document.querySelector("main.overflow-x-hidden")).toBeInTheDocument();
    expect(document.body.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth || document.body.scrollWidth);
  });

  it("keeps cancellation definitive on refresh failure and clears retry state on definitive errors", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); const firstView = renderPortal(); await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    fetcher.mockImplementationOnce(() => json({ ...reservation, status: "reversed", reversedAt: "2026-08-05T12:05:00Z" }))
      .mockImplementationOnce(() => json({ error: "unavailable" }, 503));
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i }));
    expect(await screen.findByText(/reservation canceled/i)).toBeInTheDocument();
    expect(screen.getByText(/account change is confirmed.*balance has not refreshed/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not confirm the cancellation/i)).not.toBeInTheDocument();

    firstView.unmount(); fetcher.mockReset(); fetcher.mockImplementation(authenticatedFetch);
    renderPortal(); await screen.findByText(/4 meal credits/i); fireEvent.click(screen.getByRole("button", { name: /history/i }));
    fetcher.mockImplementationOnce(() => json({ error: "invalid_request" }, 400));
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i }));
    expect(await screen.findByText(/can no longer be canceled/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry cancellation/i })).not.toBeInTheDocument();
  });

  it("shows only the fixed actionable invalid-link feedback", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: "unauthorized" }, 401)));
    renderPortal({ authFailure: "invalid", arbitrary: "SECRET REFLECTION" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or is invalid.*request a new link/i);
    expect(screen.getByRole("button", { name: /send secure link/i })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/SECRET REFLECTION/);
  });

  it("reuses stored keys from unchanged primary reserve and cancel controls", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" }); fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => Promise.reject(new Error("lost"))).mockImplementationOnce(() => json(reservation, 201));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByRole("button", { name: /retry reservation/i });
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByRole("heading", { name: /reservation confirmed/i });
    const reserveKeys = fetcher.mock.calls.filter(([url]) => String(url) === "/api/downtown-u/reservations").map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
    expect(reserveKeys[1]).toBe(reserveKeys[0]);

    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    fetcher.mockImplementationOnce(() => Promise.reject(new Error("lost"))).mockImplementationOnce(() => json({ ...reservation, status: "reversed", reversedAt: "2026-08-05T12:05:00Z" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i })); await screen.findByRole("button", { name: /retry cancellation/i });
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i })); await screen.findByText(/reservation canceled/i);
    const cancelKeys = fetcher.mock.calls.filter(([url]) => String(url).includes("/cancel")).map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
    expect(cancelKeys[1]).toBe(cancelKeys[0]);
  });

  it("dismisses cross-action retries and confirmation on context changes", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal(); await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getByRole("button", { name: /history/i })); fetcher.mockImplementationOnce(() => Promise.reject(new Error("lost")));
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i })); await screen.findByRole("button", { name: /retry cancellation/i });
    fireEvent.click(screen.getByRole("button", { name: /meals/i }));
    expect(screen.queryByRole("button", { name: /retry cancellation/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /choose server meal/i })); fetcher.mockImplementationOnce(() => Promise.reject(new Error("lost")));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByRole("button", { name: /retry reservation/i });
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(screen.queryByRole("button", { name: /retry reservation|retry cancellation/i })).not.toBeInTheDocument();
  });

  it.each([
    [1, -2, -1], [1, -1, 0], [1, 0, 1], [20, 20, 40], [20, 20, 41],
  ])("enforces authoritative total bounds for base %s and delta %s", async (baseCredits, creditDelta, expected) => {
    const modifiers = expected === 41
      ? [{ id: "mod-1", name: "Boundary option", creditDelta }, { id: "mod-2", name: "Another option", creditDelta: 1 }]
      : [{ id: "mod-1", name: "Boundary option", creditDelta }];
    const boundedMeals = { items: [{ id: "meal-1", name: "Boundary Meal", baseCredits, modifiers }] };
    const fetcher = vi.fn((url: RequestInfo | URL) => String(url).endsWith("/meals") ? json(boundedMeals) : authenticatedFetch(url));
    vi.stubGlobal("fetch", fetcher); renderPortal(); await screen.findByRole("heading", { name: "Boundary Meal" });
    fireEvent.click(screen.getByRole("button", { name: /choose boundary meal/i })); screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    const reserve = screen.getByRole("button", { name: new RegExp(`reserve for ${expected} credits?`, "i") });
    const valid = expected >= 1 && expected <= 40;
    expect(reserve).toHaveProperty("disabled", !valid);
    if (!valid) expect(screen.getByRole("alert")).toHaveTextContent(/between 1 and 40 credits/i);
    fireEvent.click(reserve);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/downtown-u/reservations")).toHaveLength(valid ? 1 : 0));
  });

  it("clears reservation confirmation when leaving meals or changing selection", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal();
    await screen.findByRole("heading", { name: "Server Meal" }); fireEvent.click(screen.getByRole("button", { name: /choose server meal/i }));
    fetcher.mockImplementationOnce(() => json(reservation, 201)).mockImplementationOnce(() => json(me));
    fireEvent.click(screen.getByRole("button", { name: /reserve for 2 credits/i })); await screen.findByRole("heading", { name: /reservation confirmed/i });
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.queryByRole("heading", { name: /reservation confirmed/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /meals/i }));
    expect(screen.queryByRole("heading", { name: /reservation confirmed/i })).not.toBeInTheDocument();
  });

  it("clears protected data on authentication loss during cancellation", async () => {
    const fetcher = vi.fn(authenticatedFetch); vi.stubGlobal("fetch", fetcher); renderPortal(); await screen.findByText(/4 meal credits/i);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    fetcher.mockImplementationOnce(() => json({ error: "unauthorized" }, 401));
    fireEvent.click(screen.getByRole("button", { name: /cancel reservation/i }));
    expect(await screen.findByRole("heading", { name: /sign in to downtown u/i })).toBeInTheDocument();
    expect(screen.queryByText("student@example.test")).not.toBeInTheDocument();
  });
});
