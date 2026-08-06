import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import OperatorDashboard from "../OperatorDashboard";

const studentId = "123e4567-e89b-42d3-a456-426614174000";
const keyUuid = "223e4567-e89b-42d3-a456-426614174000";
const challengeId = "323e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-08-06T11:00:00.000Z";
const updatedAt = "2026-08-06T12:00:00.000Z";
const later = "2026-08-06T12:01:00.000Z";
const student = (eligibilityStatus: "pending" | "approved" | "rejected" | "suspended" = "pending", changes = {}) => ({
  id: studentId, eligibilityStatus, maskedEmail: "p***@e***.test", maskedPhone: "+***********1234",
  createdAt, updatedAt, ...changes,
});
const sessions = {
  reviewerStale: { authenticated: true, operator: { displayName: "Pat Lee", roles: ["eligibility_reviewer"] }, smsReauthFresh: false },
  reviewerFresh: { authenticated: true, operator: { displayName: "Pat Lee", roles: ["eligibility_reviewer"] }, smsReauthFresh: true },
  reconciliation: { authenticated: true, operator: { displayName: "Rae Kim", roles: ["reconciliation_operator"] }, smsReauthFresh: true },
  scoped: { authenticated: true, operator: { displayName: "Alex Doe", roles: ["credit_adjuster", "audit_exporter"] }, smsReauthFresh: false },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
}));
function mount(path: string, prepare?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  prepare?.(client);
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/downtown-u/operator/*" element={<OperatorDashboard />} />
  </Routes></MemoryRouter></QueryClientProvider>) };
}
function listOrExact(url: string, value = student()) {
  return json({ items: [value], nextCursor: null });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe("eligibility review authorization, routing, and projection", () => {
  it("adds only a Review link to reviewer student rows/cards and fresh-fetches the canonical exact detail route", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      return listOrExact(url);
    });
    vi.stubGlobal("fetch", fetcher); mount("/downtown-u/operator/students");
    const links = await screen.findAllByRole("link", { name: "Review student" });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", `/downtown-u/operator/students/${studentId}`);
    expect(screen.queryByRole("button", { name: /approve|reject|suspend|reinstate/i })).not.toBeInTheDocument();
    fireEvent.click(links[0]);
    expect(await screen.findByRole("heading", { name: "Student eligibility" })).toHaveFocus();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/api/downtown-u/operator/students?limit=25&studentId=${studentId}`,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" }),
    ));
    expect(screen.getByText(studentId)).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("p***@e***.test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to students" })).toHaveAttribute("href", "/downtown-u/operator/students");
    expect(document.body).not.toHaveTextContent(/balance|provider|internal|audit|reason/i);
  });

  it.each([
    [sessions.reconciliation, "/downtown-u/operator/students", true],
    [sessions.reconciliation, `/downtown-u/operator/students/${studentId}`, false],
    [sessions.scoped, `/downtown-u/operator/students/${studentId}`, false],
    [sessions.reviewerFresh, `/downtown-u/operator/students/${studentId.toUpperCase()}`, false],
  ])("allows read-only Students only where scoped and canonical, but makes no unauthorized detail/mutation request %#", async (session, path, mayReadList) => {
    const fetcher = vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(session) : listOrExact(String(input)));
    vi.stubGlobal("fetch", fetcher); mount(path);
    await screen.findByRole("heading", { name: mayReadList ? "Students" : "Access unavailable" });
    expect(screen.queryByRole("link", { name: "Review student" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|reject|suspend|reinstate/i })).not.toBeInTheDocument();
    if (!mayReadList) expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails canonical route validation and handles exact not-found/deleted targets without stale list details or controls", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.includes("studentId=")) return json({ items: [], nextCursor: null });
      return listOrExact(url, student("approved", { approvedAt: updatedAt }));
    });
    vi.stubGlobal("fetch", fetcher); mount(`/downtown-u/operator/students/${studentId}`);
    expect(await screen.findByRole("heading", { name: "Student not found" })).toHaveFocus();
    expect(document.body).not.toHaveTextContent("Approved");
    expect(screen.queryByRole("button", { name: /approve|reject|suspend|reinstate/i })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders a deleted student row without a Review link while retaining the safe list projection", async () => {
    const deleted = student("pending", { deletedAt: later });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(sessions.reviewerFresh) : listOrExact(String(input), deleted)));
    mount("/downtown-u/operator/students");
    expect((await screen.findAllByText("p***@e***.test")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Review student" })).not.toBeInTheDocument();
  });

  it("shows an exact deleted student as archived and never exposes eligibility mutation UI", async () => {
    const deleted = student("approved", { approvedAt: updatedAt, deletedAt: later });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(sessions.reviewerFresh) : listOrExact(String(input), deleted)));
    mount(`/downtown-u/operator/students/${studentId}`);
    expect(await screen.findByRole("heading", { name: "Archived student" })).toBeInTheDocument();
    expect(screen.getByText(studentId)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|reject|suspend|reinstate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("eligibility-decisions"), expect.anything());
  });

  it.each([false, true])("ends the session and purges protected exact detail after a 401 (cached=%s)", async (cached) => {
    const fetcher = vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session")
      ? json(sessions.reviewerFresh)
      : json({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetcher);
    const { client } = mount(`/downtown-u/operator/students/${studentId}`, cached ? (queryClient) => {
      queryClient.setQueryData(["operator", "students", "detail", studentId], student());
    } : undefined);
    expect(await screen.findByRole("heading", { name: "Session ended" })).toBeInTheDocument();
    await waitFor(() => expect(client.getQueriesData({ queryKey: ["operator"] }).every(([, data]) => data === undefined)).toBe(true));
    expect(document.body).not.toHaveTextContent(studentId);
    expect(screen.queryByRole("button", { name: /approve|reject|suspend|reinstate/i })).not.toBeInTheDocument();
  });
});

describe("eligibility mutation wizard", () => {
  it.each([
    ["pending", ["Approve", "Reject"]],
    ["approved", ["Suspend"]],
    ["suspended", ["Reinstate"]],
    ["rejected", []],
  ] as const)("presents only server-valid %s transitions", async (status, actions) => {
    const lifecycle = status === "approved" ? { approvedAt: updatedAt } : status === "suspended" ? { approvedAt: createdAt, suspendedAt: updatedAt } : status === "rejected" ? { rejectedAt: updatedAt } : {};
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(sessions.reviewerFresh) : listOrExact(String(input), student(status, lifecycle))));
    mount(`/downtown-u/operator/students/${studentId}`);
    await screen.findByRole("heading", { name: "Student eligibility" });
    for (const action of ["Approve", "Reject", "Suspend", "Reinstate"]) {
      const control = screen.queryByRole("button", { name: action });
      if (actions.includes(action as never)) expect(control).toBeInTheDocument(); else expect(control).not.toBeInTheDocument();
    }
  });

  it("uses one accessible Edit→Review dialog, constrained human reasons, canonical note validation, focus trap/restoration, and 44px targets", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(sessions.reviewerFresh) : listOrExact(String(input))));
    mount(`/downtown-u/operator/students/${studentId}`);
    const opener = await screen.findByRole("button", { name: "Reject" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Reject student eligibility" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByRole("heading", { name: "Edit decision" })).toHaveFocus();
    const reason = within(dialog).getByLabelText("Reason");
    expect(within(reason).getAllByRole("option").map(option => option.textContent)).toEqual(["Select a reason", "Documentation incomplete", "Policy ineligible"]);
    expect(document.body).not.toHaveTextContent(/documentation_incomplete|policy_ineligible/);
    const note = within(dialog).getByLabelText("Decision note");
    expect(note).toHaveAttribute("maxlength", "2000");
    expect(within(dialog).getByText(/Do not include contact, payment, health, or other sensitive information/i)).toBeInTheDocument();
    fireEvent.change(reason, { target: { value: "documentation_incomplete" } });
    fireEvent.change(note, { target: { value: " \ud800 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review decision" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/valid note/i);
    fireEvent.change(note, { target: { value: "  Cafe\u0301 documents missing  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review decision" }));
    expect(within(dialog).getByRole("heading", { name: "Review decision" })).toHaveFocus();
    expect(within(dialog).getByText("Café documents missing")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reject student eligibility" })).toBeInTheDocument();
    for (const button of within(dialog).getAllByRole("button")) expect(button).toHaveClass("min-h-11");
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector('[class*="overflow-x-auto"]')).not.toBeInTheDocument();
  });

  it("permits exactly 500 astral Unicode scalars in the UI and rejects 501", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("/session") ? json(sessions.reviewerFresh) : listOrExact(String(input))));
    mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    const note = screen.getByLabelText("Decision note");
    fireEvent.change(note, { target: { value: "🎓".repeat(500) } });
    expect(note).toHaveValue("🎓".repeat(500));
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    expect(screen.getByRole("heading", { name: "Review decision" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit decision" }));
    const oversized = "🎓".repeat(501);
    fireEvent.paste(screen.getByLabelText("Decision note"), { clipboardData: { getData: () => oversized } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: oversized } });
    expect(screen.getByLabelText("Decision note")).toHaveValue(oversized);
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid note/i);
  });

  it("canonicalizes a PostgreSQL offset/microsecond read timestamp before signing and posting", async () => {
    const postgresUpdatedAt = "2026-08-06T12:00:00.123456+00:00";
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") {
        return json({ result: { studentId, eligibilityStatus: "approved", eligibilityReviewedAt: later, approvedAt: later, updatedAt: later }, replayed: false }, 200, { "x-correlation-id": `operator-mutation:${keyUuid}` });
      }
      return listOrExact(url, student("pending", { updatedAt: postgresUpdatedAt }));
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) });
    vi.stubGlobal("fetch", fetcher); mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    await screen.findByRole("status", { name: "Eligibility approved" });
    const post = fetcher.mock.calls.find(([url]) => String(url).endsWith("/eligibility-decisions"));
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ expectedUpdatedAt: "2026-08-06T12:00:00.123Z" });
  });

  it("keeps a conflated 401 wrong-OTP/session response generic without purging the operator session", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerStale);
      if (url.endsWith("/reauth/request")) return json({ accepted: true, challengeId }, 202);
      if (url.endsWith("/reauth/verify")) return json({ reauthenticated: false }, 401);
      return listOrExact(url);
    });
    vi.stubGlobal("fetch", fetcher); const { client } = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to verification" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send verification code" }));
    fireEvent.change(await screen.findByLabelText("Six-digit verification code"), { target: { value: "012345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t verify that code/i);
    expect(screen.getByRole("heading", { name: "Verify your access" })).toBeInTheDocument();
    expect(client.getQueryData(["operator", "session"])).toEqual(sessions.reviewerStale);
    expect(screen.queryByRole("heading", { name: "Session ended" })).not.toBeInTheDocument();
  });

  it("reauthenticates after Review, hides secrets, refetches exact state, and requires reconfirmation when it changed", async () => {
    let exactReads = 0;
    const changed = student("pending", { updatedAt: later });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerStale);
      if (url.endsWith("/reauth/request")) return json({ accepted: true, challengeId }, 202);
      if (url.endsWith("/reauth/verify")) return json({ reauthenticated: true, validForSeconds: 300 });
      if (url.includes("studentId=")) return listOrExact(url, ++exactReads === 1 ? student() : changed);
      if (init?.method === "POST") throw new Error("must reconfirm before mutation");
      return listOrExact(url);
    });
    vi.stubGlobal("fetch", fetcher); const { client } = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    expect(screen.getByRole("heading", { name: "Review decision" })).toHaveFocus();
    expect(screen.getByText("Approving will mark this student eligible for Downtown U benefits.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to verification" }));
    expect(await screen.findByRole("heading", { name: "Verify your access" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    const otp = await screen.findByLabelText("Six-digit verification code");
    fireEvent.change(otp, { target: { value: "012345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/student record changed/i);
    expect(screen.getByRole("button", { name: "Review latest" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve student eligibility" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(new RegExp(`${challengeId}|012345`));
    expect(fetcher).toHaveBeenCalledWith(`/api/downtown-u/operator/students?limit=25&studentId=${studentId}`, expect.any(Object));
    expect(client.getQueryData(["operator", "session"])).toEqual({ ...sessions.reviewerStale, smsReauthFresh: true });
  });

  it("submits once without optimism, uses one semantic key, then refetches exact detail and Students page before persistent focused success", async () => {
    let resolveMutation!: (response: Response) => void;
    const mutationResponse = new Promise<Response>(resolve => { resolveMutation = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return mutationResponse;
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) });
    vi.stubGlobal("fetch", fetcher); const { client } = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    const commit = screen.getByRole("button", { name: "Approve student eligibility" });
    fireEvent.click(commit); fireEvent.click(commit);
    expect(await screen.findByRole("status")).toHaveTextContent("Submitting decision");
    expect(commit).toBeDisabled();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(1);
    resolveMutation(await json({ result: { studentId, eligibilityStatus: "approved", eligibilityReviewedAt: later, approvedAt: later, updatedAt: later }, replayed: false }, 200, { "x-correlation-id": `operator-mutation:${keyUuid}` }));
    const success = await screen.findByText("Eligibility approved", { selector: '[role="status"]' });
    await waitFor(() => expect(success).toHaveFocus());
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/students?")).length).toBeGreaterThanOrEqual(3));
    expect(client.getQueriesData({ queryKey: ["operator", "students"] }).some(([, data]) => data === undefined)).toBe(false);
    expect(document.body).not.toHaveTextContent(keyUuid);
    expect(localStorage).toHaveLength(0); expect(sessionStorage).toHaveLength(0);
  });

  it("cannot be dismissed by Escape or outside interaction while submitting and sends exactly once", async () => {
    let resolveMutation!: (response: Response) => void;
    const mutationResponse = new Promise<Response>(resolve => { resolveMutation = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return mutationResponse;
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) });
    vi.stubGlobal("fetch", fetcher); mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve student eligibility" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(dialog).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(1);
    resolveMutation(await json({ result: { studentId, eligibilityStatus: "approved", eligibilityReviewedAt: later, approvedAt: later, updatedAt: later }, replayed: false }, 200, { "x-correlation-id": `operator-mutation:${keyUuid}` }));
    expect(await screen.findByRole("status", { name: "Eligibility approved" })).toBeInTheDocument();
  });

  it("commits authoritative response to the exact cache after external unmount during an in-flight mutation", async () => {
    let resolveMutation!: (response: Response) => void;
    const mutationResponse = new Promise<Response>(resolve => { resolveMutation = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return mutationResponse;
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) });
    vi.stubGlobal("fetch", fetcher); const mounted = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Submitting decision");
    mounted.unmount();
    resolveMutation(await json({ result: { studentId, eligibilityStatus: "approved", eligibilityReviewedAt: later, approvedAt: later, updatedAt: later }, replayed: false }, 200, { "x-correlation-id": `operator-mutation:${keyUuid}` }));
    await waitFor(() => expect(mounted.client.getQueryData(["operator", "students", "detail", studentId])).toEqual(
      student("approved", { eligibilityReviewedAt: later, approvedAt: later, updatedAt: later }),
    ));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(1);
  });

  it("keeps authoritative success and exact cache even when every best-effort refresh rejects", async () => {
    let exactReads = 0;
    const authoritative = { studentId, eligibilityStatus: "approved" as const, eligibilityReviewedAt: later, approvedAt: later, updatedAt: later };
    const authoritativeStudent = student("approved", { eligibilityReviewedAt: later, approvedAt: later, updatedAt: later });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return json({ result: authoritative, replayed: false }, 200, { "x-correlation-id": `operator-mutation:${keyUuid}` });
      if (url.includes("studentId=")) return ++exactReads === 1 ? listOrExact(url) : Promise.reject(new Error("detail refresh failed"));
      if (url.includes("/students?")) return Promise.reject(new Error("list refresh failed"));
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) }); vi.stubGlobal("fetch", fetcher);
    const { client } = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Documents verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    const success = await screen.findByRole("status", { name: "Eligibility approved" });
    await waitFor(() => expect(success).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(client.getQueryData(["operator", "students", "detail", studentId])).toEqual(authoritativeStudent);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("refresh"))).toBe(false);
  });

  it("preserves the note but blocks commit on 409 until Review latest, and handles 428 without discarding the draft", async () => {
    let posts = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return ++posts === 1 ? json({ error: "reauth_required" }, 428) : json({ error: "stale_state" }, 409);
      if (url.endsWith("/reauth/request")) return json({ accepted: true, challengeId }, 202);
      if (url.endsWith("/reauth/verify")) return json({ reauthenticated: true, validForSeconds: 300 });
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) }); vi.stubGlobal("fetch", fetcher);
    mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Keep this note" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    expect(await screen.findByRole("heading", { name: "Verify your access" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    fireEvent.change(await screen.findByLabelText("Six-digit verification code"), { target: { value: "012345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve student eligibility" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/record changed|latest/i);
    expect(screen.getByText("Keep this note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review latest" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve student eligibility" })).not.toBeInTheDocument();
  });

  it.each([
    [401, "Session ended"], [403, "Eligibility access changed"],
    [429, "Decision unavailable"], [503, "Decision unavailable"],
  ] as const)("handles mutation HTTP %s conservatively without optimistic state", async (status, heading) => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") {
        const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : "unavailable";
        return json({ error: code }, status);
      }
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keyUuid) }); vi.stubGlobal("fetch", fetcher);
    const { client } = mount(`/downtown-u/operator/students/${studentId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "documentation_verified" } });
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Preserve this note" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    expect(await screen.findByRole(status === 401 ? "heading" : "alert", { name: status === 401 ? heading : undefined })).toHaveTextContent(heading);
    expect(document.body).not.toHaveTextContent("private_detail");
    if (status !== 401) expect(document.body).toHaveTextContent("Pending");
    if (status === 401) {
      expect(client.getQueriesData({ queryKey: ["operator"] }).every(([, data]) => data === undefined)).toBe(true);
      expect(screen.queryByRole("button", { name: /approve|reject/i })).not.toBeInTheDocument();
    } else if (status === 403) {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/session")).length).toBeGreaterThan(1);
    } else {
      expect(screen.getByText("Preserve this note")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    }
  });

  it("reuses a semantic draft key for generic retry but generates a new key after intent changes", async () => {
    const user = userEvent.setup();
    const uuids = [keyUuid, "423e4567-e89b-42d3-a456-426614174000"];
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session")) return json(sessions.reviewerFresh);
      if (url.endsWith("/eligibility-decisions") && init?.method === "POST") return json({ error: "unavailable" }, 503);
      return listOrExact(url);
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => uuids.shift()!) }); vi.stubGlobal("fetch", fetcher);
    mount(`/downtown-u/operator/students/${studentId}`);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.selectOptions(screen.getByLabelText("Reason"), "documentation_verified");
    await user.type(screen.getByLabelText("Decision note"), "Same intent");
    await user.click(screen.getByRole("button", { name: "Review decision" }));
    await user.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(2));
    let posts = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"));
    expect((posts[0][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe((posts[1][1]?.headers as Record<string, string>)["Idempotency-Key"]);
    await user.click(await screen.findByRole("button", { name: "Edit decision" }));
    let note = screen.getByLabelText("Decision note");
    await user.clear(note);
    await user.type(note, "Temporary edit");
    await user.clear(note);
    await user.type(note, "Same intent");
    await user.click(screen.getByRole("button", { name: "Review decision" }));
    await user.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(3));
    posts = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"));
    expect((posts[2][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe((posts[1][1]?.headers as Record<string, string>)["Idempotency-Key"]);

    await user.click(await screen.findByRole("button", { name: "Edit decision" }));
    note = screen.getByLabelText("Decision note");
    await user.clear(note);
    await user.type(note, "Changed intent");
    await user.click(screen.getByRole("button", { name: "Review decision" }));
    await user.click(screen.getByRole("button", { name: "Approve student eligibility" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"))).toHaveLength(4));
    posts = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/eligibility-decisions"));
    expect((posts[3][1]?.headers as Record<string, string>)["Idempotency-Key"]).not.toBe((posts[2][1]?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(document.body).not.toHaveTextContent(/opm:v1:/);
  });
});
