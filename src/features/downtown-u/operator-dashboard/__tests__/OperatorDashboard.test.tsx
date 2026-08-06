import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OperatorDashboard from "../OperatorDashboard";

const studentId = "123e4567-e89b-42d3-a456-426614174000";
const itemId = "223e4567-e89b-42d3-a456-426614174000";
const iso = "2026-08-04T12:00:00Z";
const providerEarlier = "2026-08-04T11:59:00Z";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
const sessions = {
  reviewer: { authenticated: true, operator: { displayName: "Pat Lee", roles: ["eligibility_reviewer"] }, smsReauthFresh: false },
  reconciliation: { authenticated: true, operator: { displayName: "Rae Kim", roles: ["reconciliation_operator"] }, smsReauthFresh: true },
  scoped: { authenticated: true, operator: { displayName: "Alex Doe", roles: ["credit_adjuster", "audit_exporter"] }, smsReauthFresh: false },
};
function mount(path: string, session: unknown = sessions.reviewer) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/downtown-u/operator/*" element={<OperatorDashboard />} />
    <Route path="/downtown-u/operator/auth" element={<p>Sign in destination</p>} />
  </Routes></MemoryRouter></QueryClientProvider>) };
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("role-aware shell and session boundary", () => {
  it("redirects root by role, renders mapped role labels, and never renders role codes", async () => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reviewer) : json({ items: [], nextCursor: null })));
    mount("/downtown-u/operator");
    expect(await screen.findByRole("heading", { name: "Students" })).toHaveFocus();
    expect(screen.getByRole("list", { name: "Access areas" })).toHaveTextContent("Eligibility review");
    expect(document.body).not.toHaveTextContent("eligibility_reviewer");
  });

  it("shows only authorized nav and never calls a forbidden direct list route", async () => {
    const fetcher = vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.scoped) : json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator/students", sessions.scoped);
    expect(await screen.findByRole("heading", { name: "Access unavailable" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: "Students" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/credit_adjuster|audit_exporter/);
  });

  it("allows reconciliation staff to navigate to and directly load the global Students list", async () => {
    const fetcher = vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reconciliation) : json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator/students", sessions.reconciliation);
    expect(await screen.findByRole("heading", { name: "Students" })).toHaveFocus();
    expect(screen.getAllByRole("link", { name: "Students" }).length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/downtown-u/operator/students?"), expect.any(Object));
    expect(screen.getByRole("list", { name: "Access areas" })).toHaveTextContent("Reconciliation");
    expect(document.body).not.toHaveTextContent("reconciliation_operator");
  });

  it("purges protected queries and records on 401 and offers sign in", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json({ authenticated: false }, 401) : json({ items: [], nextCursor: null })));
    const { client } = mount("/downtown-u/operator/students");
    client.setQueryData(["operator", "students", {}], { items: [{ id: itemId }], nextCursor: null });
    expect(await screen.findByRole("heading", { name: "Session ended" })).toBeInTheDocument();
    expect(client.getQueriesData({ queryKey: ["operator"] }).every(([,data]) => data === undefined)).toBe(true);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/downtown-u/operator/auth");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows generic session unavailability and retries without exposing response details", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ error: "database secret" }, 503)).mockImplementationOnce(() => json(sessions.scoped));
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator");
    expect(await screen.findByRole("heading", { name: "Dashboard unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Dashboard unavailable");
    expect(document.body).not.toHaveTextContent("database secret");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Operator home" })).toBeInTheDocument();
  });
});

describe("read-only list pages", () => {
  it("renders students in equivalent desktop and mobile records, filters, and paginates without exposing cursors", async () => {
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      const value = String(url); if (value.endsWith("/session")) return json(sessions.reviewer);
      return json({ items: [{ id: studentId, eligibilityStatus: "approved", maskedEmail: "p***@e***.test", maskedPhone: "+***********1234", createdAt: iso, updatedAt: iso }], nextCursor: value.includes("cursor=") ? null : "opaque.sig" });
    });
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator/students");
    expect(await screen.findByRole("table", { name: "Students" })).toBeInTheDocument();
    expect(screen.getAllByText("Approved")).toHaveLength(3);
    expect(screen.getByRole("list", { name: "Students mobile records" })).toBeInTheDocument();
    expect(screen.getAllByTitle(studentId)[0]).toHaveTextContent("123e4567");
    expect(screen.getAllByText("+***********1234")).toHaveLength(2);
    expect(document.body).not.toHaveTextContent("+123456789012345");
    expect(document.body).not.toHaveTextContent("opaque.sig");
    fireEvent.change(screen.getByLabelText("Eligibility status"), { target: { value: "approved" } });
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining("eligibilityStatus=approved"), expect.any(Object)));
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining("cursor=opaque.sig"), expect.any(Object)));
    expect(await screen.findByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it.each([
    ["purchases", "Purchases", { id: itemId, studentId, planId: "flex-5", creditsGranted: 5, priceCents: 6000, currency: "USD", status: "paid", refundedCredits: 0, paidAt: providerEarlier, createdAt: iso, updatedAt: iso }, "$60.00"],
    ["redemptions", "Meal activity", { id: itemId, studentId, mealName: "Lunch service", credits: 1, status: "redeemed", reservedAt: iso, redeemedAt: iso, createdAt: iso, updatedAt: iso }, "Lunch service"],
    ["reconciliation", "Reconciliation", { id: itemId, studentId, category: "payment_follow_up", state: "needs_review", openedAt: iso }, "Payment follow-up"],
  ])("renders %s approved data in desktop and mobile without actions", async (endpoint, heading, item, visible) => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reconciliation) : json({ items: [item], nextCursor: null })));
    mount(`/downtown-u/operator/${endpoint}`, sessions.reconciliation);
    expect(await screen.findByRole("heading", { name: heading })).toHaveFocus();
    await waitFor(() => expect(screen.getAllByText(visible).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("button", { name: /edit|refund|reverse|resolve|export/i })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Square|request id/i);
  });

  it("rejects malformed and uppercase student UUIDs without loading, then fetches once for canonical input", async () => {
    const fetcher = vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reconciliation) : json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator/purchases", sessions.reconciliation);
    await screen.findByRole("heading", { name: "Purchases" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const initialCalls = fetcher.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Student ID"), { target: { value: "not-an-id" } });
    expect(screen.getByRole("alert")).toHaveTextContent("valid student ID");
    expect(screen.queryByText("Loading records")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(initialCalls);
    fireEvent.change(screen.getByLabelText("Student ID"), { target: { value: studentId.toUpperCase() } });
    expect(screen.getByRole("alert")).toHaveTextContent("valid student ID");
    expect(screen.queryByText("Loading records")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(initialCalls);
    fireEvent.change(screen.getByLabelText("Student ID"), { target: { value: studentId } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(initialCalls + 1));
    expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining(`studentId=${studentId}`), expect.any(Object));
  });

  it("does not announce ordinary empty records as an error", async () => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reviewer) : json({ items: [], nextCursor: null })));
    mount("/downtown-u/operator/students");
    expect(await screen.findByRole("heading", { name: "No records yet" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses accessible responsive structure without page horizontal overflow", async () => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reconciliation) : json({ items: [], nextCursor: null })));
    mount("/downtown-u/operator/reconciliation", sessions.reconciliation);
    await screen.findByRole("heading", { name: "Reconciliation" });
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#operator-main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "operator-main");
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveClass("min-h-11");
    expect(document.querySelector('[class*="h-screen"]')).not.toBeInTheDocument();
    expect(document.querySelector('[class*="overflow-x-auto"]')).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Operator sections" })).getByRole("link", { name: "Reconciliation" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the shell identity stable between operator sections", async () => {
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session") ? json(sessions.reconciliation) : json({ items: [], nextCursor: null })));
    mount("/downtown-u/operator/purchases", sessions.reconciliation);
    await screen.findByRole("heading", { name: "Purchases" });
    const shell = screen.getByTestId("operator-shell");
    fireEvent.click(screen.getByRole("link", { name: "Meal activity" }));
    expect(await screen.findByRole("heading", { name: "Meal activity" })).toHaveFocus();
    expect(screen.getByTestId("operator-shell")).toBe(shell);
  });
});
