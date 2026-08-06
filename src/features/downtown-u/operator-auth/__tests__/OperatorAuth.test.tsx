import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../../App";
import OperatorAuth from "../OperatorAuth";
import { consumeOperatorAuthFragment, type OperatorLinkCredentials } from "../fragment";

const flowId = "123e4567-e89b-42d3-a456-426614174000";
const challengeId = "223e4567-e89b-42d3-a456-426614174000";
const smsChallengeId = "323e4567-e89b-42d3-a456-426614174000";
const flowVerifier = "F".repeat(43);
const verifier = "V".repeat(43);
const credentials: OperatorLinkCredentials = { flowId, flowVerifier, challengeId, verifier };
const json = (body: unknown, status = 200, type = "application/json; charset=utf-8") => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } }));

function Destination() { const location = useLocation(); return <p>destination:{location.pathname}</p>; }
function renderAuth(initialCredentials: OperatorLinkCredentials | null | undefined = null) {
  return render(<MemoryRouter initialEntries={["/downtown-u/operator/auth"]}><Routes>
    <Route path="/downtown-u/operator/auth" element={<OperatorAuth initialCredentials={initialCredentials} />} />
    <Route path="/downtown-u/operator" element={<Destination />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/downtown-u/operator/auth");
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => json({ authenticated: false }, 401)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("operator auth fragment boundary", () => {
  it("integrates the real BrowserRouter route with the canonical delivered URL", async () => {
    const deliveredUrl = `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`;
    window.history.replaceState(null, "", deliveredUrl);
    const fetcher = vi.fn(() => json({ mfaRequired: true, smsChallengeId }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    expect(window.location.pathname).toBe("/downtown-u/operator/auth");
    expect(window.location.hash).toBe("");
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("consumes a canonical link delivered into the already-mounted auth SPA before verifying", async () => {
    let resolveSession!: (response: Response) => void;
    const pendingSession = new Promise<Response>((resolve) => { resolveSession = resolve; });
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      if (String(url).endsWith("/session")) return pendingSession;
      expect(String(url)).toBe("/api/downtown-u/operator/auth/verify-email");
      expect(window.location.hash).toBe("");
      return json({ mfaRequired: true, smsChallengeId });
    });
    const consoleSpies = (["error", "warn", "info", "log"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/operator/auth/session", expect.any(Object)));

    const deliveredUrl = `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`;
    window.history.replaceState(null, "", deliveredUrl);
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    expect(window.location.pathname).toBe("/downtown-u/operator/auth");
    expect(window.location.hash).toBe("");
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("/api/downtown-u/operator/auth/verify-email", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(credentials),
    }));
    expect(document.body.textContent).not.toMatch(new RegExp(`${flowId}|${flowVerifier}|${challengeId}|${verifier}`));
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/123e4567|FFFF|VVVV/);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).join(" ")).not.toMatch(new RegExp(`${flowId}|${flowVerifier}|${challengeId}|${verifier}`));

    await act(async () => {
      resolveSession(await json({ authenticated: true, operator: { displayName: "Pat", roles: ["audit_exporter"] }, smsReauthFresh: false }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(window.location.pathname).toBe("/downtown-u/operator/auth");
  });

  it("routes a malformed canonical fragment delivered into the mounted SPA to a generic restart", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    window.history.replaceState(null, "", `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=bad&unknown=x`);
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    expect(window.location.pathname).toBe("/downtown-u/operator/auth");
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not verify.*invalid or expired/i);
    expect(screen.getByRole("button", { name: /start again/i })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("routes a malformed canonical fragment to a generic restart without verifying", () => {
    window.history.replaceState(null, "", `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=bad&unknown=x`);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<App />);
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not verify.*invalid or expired/i);
    expect(screen.getByRole("button", { name: /start again/i })).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("copies an exact canonical link and clears the entire fragment synchronously", () => {
    window.history.replaceState(null, "", `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`);
    const replace = vi.spyOn(window.history, "replaceState");
    expect(consumeOperatorAuthFragment()).toEqual({ kind: "valid", credentials });
    expect(window.location.pathname).toBe("/downtown-u/operator/auth");
    expect(window.location.hash).toBe("");
    expect(replace).toHaveBeenCalledOnce();
  });

  it.each([
    `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=short`,
    `/downtown-u/operator/auth#flowId=${flowId}&flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`,
    `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}&extra=x`,
  ])("clears malformed, duplicate, and unknown fragment data without retaining it", (url) => {
    window.history.replaceState(null, "", url);
    expect(consumeOperatorAuthFragment()).toEqual({ kind: "invalid" });
    expect(window.location.href).not.toMatch(/flowId|flowVerifier|challengeId|verifier|extra/);
  });

  it("does not consume or clear an unrelated route anchor", () => {
    window.history.replaceState(null, "", "/privacy-policy#retention");
    expect(consumeOperatorAuthFragment()).toEqual({ kind: "none" });
    expect(window.location.pathname).toBe("/privacy-policy");
    expect(window.location.hash).toBe("#retention");
  });

  it("does not consume or reset App for an unrelated route anchor hashchange", () => {
    window.history.replaceState(null, "", "/privacy-policy");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    window.history.replaceState(null, "", "/privacy-policy#retention");
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    expect(window.location.pathname).toBe("/privacy-policy");
    expect(window.location.hash).toBe("#retention");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("clears before verify fetch and never exposes or persists link credentials", async () => {
    window.history.replaceState(null, "", `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`);
    const order: string[] = [];
    vi.spyOn(window.history, "replaceState").mockImplementation(function (data, unused, url) {
      order.push("clear"); return History.prototype.replaceState.call(window.history, data, unused, url);
    });
    vi.stubGlobal("fetch", vi.fn(() => { order.push("fetch"); return json({ mfaRequired: true, smsChallengeId }); }));
    render(<MemoryRouter><OperatorAuth /></MemoryRouter>);
    expect(order.slice(0, 2)).toEqual(["clear", "fetch"]);
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(new RegExp(`${flowId}|${flowVerifier}|${challengeId}|${verifier}`));
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/123e4567|FFFF|VVVV/);
  });

  it("does not emit canonical credentials through console methods", async () => {
    window.history.replaceState(null, "", `/downtown-u/operator/auth#flowId=${flowId}&flowVerifier=${flowVerifier}&challengeId=${challengeId}&verifier=${verifier}`);
    const spies = (["error", "warn", "info", "log"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    vi.stubGlobal("fetch", vi.fn(() => json({ mfaRequired: true, smsChallengeId })));
    render(<App />);
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    expect(spies.flatMap((spy) => spy.mock.calls).join(" ")).not.toMatch(new RegExp(`${flowId}|${flowVerifier}|${challengeId}|${verifier}`));
  });
});

describe("operator email sign-in", () => {
  it("normalizes email for UX and sends the exact bounded same-origin request", async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => json({ accepted: true }, 202)); vi.stubGlobal("fetch", fetcher); renderAuth();
    await waitFor(() => expect(fetcher).toHaveBeenCalled()); // session probe
    fireEvent.change(screen.getByLabelText(/staff email/i), { target: { value: "  OPERATOR@EXAMPLE.TEST  " } });
    fireEvent.submit(screen.getByRole("form", { name: /email sign-in/i }));
    await screen.findByRole("status", { name: /email sent/i });
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("request-link"));
    expect(call).toEqual(["/api/downtown-u/operator/auth/request-link", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: '{"email":"operator@example.test"}', signal: expect.any(AbortSignal),
    })]);
    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
  });

  it("rejects malformed email locally without fetching a link", async () => {
    const fetcher = vi.fn(() => json({ authenticated: false }, 401)); vi.stubGlobal("fetch", fetcher); renderAuth();
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText(/staff email/i), { target: { value: "not-an-email" } });
    fireEvent.submit(screen.getByRole("form", { name: /email sign-in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid email/i);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    [() => json({ accepted: true }, 202)], [() => json({ error: "provider secret detail" }, 503)], [() => Promise.reject(new Error("private network detail"))],
  ])("uses identical non-enumerating confirmation for accepted and safe failures", async (response) => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ authenticated: false }, 401)).mockImplementationOnce(response);
    vi.stubGlobal("fetch", fetcher); renderAuth(); await screen.findByLabelText(/staff email/i);
    fireEvent.change(screen.getByLabelText(/staff email/i), { target: { value: "operator@example.test" } });
    fireEvent.submit(screen.getByRole("form", { name: /email sign-in/i }));
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/provider secret|network detail|account.*not found/i);
  });
});

describe("email link and SMS MFA", () => {
  it("posts exact email credentials, accepts only exact success, then focuses OTP", async () => {
    const fetcher = vi.fn(() => json({ mfaRequired: true, smsChallengeId })); vi.stubGlobal("fetch", fetcher); renderAuth(credentials);
    const otp = await screen.findByLabelText(/six-digit code/i); expect(otp).toHaveFocus();
    expect(fetcher).toHaveBeenCalledWith("/api/downtown-u/operator/auth/verify-email", expect.objectContaining({ body: JSON.stringify(credentials) }));
  });

  it.each([
    [401, { authenticated: false }, /link.*invalid|expired/i],
    [503, { error: "unavailable" }, /temporarily unavailable/i],
    [200, { mfaRequired: true, smsChallengeId, extra: true }, /could not verify/i],
    [200, { mfaRequired: true, smsChallengeId: "bad" }, /could not verify/i],
  ])("handles verify-email status/schema safely", async (status, body, message) => {
    vi.stubGlobal("fetch", vi.fn(() => json(body, status))); renderAuth(credentials);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: status === 503 ? /try again/i : /start again/i })).toBeInTheDocument();
  });

  it("retries verify-email after 503 with the same private in-memory credentials", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ error: "unavailable" }, 503))
      .mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId }));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials);
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map((call) => call[1]?.body)).toEqual([JSON.stringify(credentials), JSON.stringify(credentials)]);
    expect(window.location.hash).toBe("");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("keeps network verify-email failures retryable", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("network down"))
      .mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId }));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials);
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
  });

  it("allows only six ASCII digits including pasted values and sends exact SMS body", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId }))
      .mockImplementationOnce(() => json({ authenticated: false }, 401));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials); const otp = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(otp, { target: { value: "１２３４５６" } }); expect(otp).toHaveValue("");
    fireEvent.change(otp, { target: { value: "12a3 456789" } }); expect(otp).toHaveValue("123456");
    fireEvent.submit(screen.getByRole("form", { name: /sms verification/i }));
    await screen.findByRole("alert");
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/downtown-u/operator/auth/verify-sms", expect.objectContaining({
      body: JSON.stringify({ flowId, flowVerifier, challengeId: smsChallengeId, otp: "123456" }),
    }));
  });

  it.each([[401, /code.*invalid/i], [503, /temporarily unavailable/i]] as const)("keeps in-memory flow retryable on SMS %s", async (status, copy) => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId })).mockImplementationOnce(() => json(status === 401 ? { authenticated: false } : { error: "unavailable" }, status));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials); const otp = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(otp, { target: { value: "123456" } }); fireEvent.submit(screen.getByRole("form", { name: /sms verification/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy); expect(screen.getByRole("button", { name: /verify and sign in/i })).not.toBeDisabled();
  });

  it("requires the exact authenticated response, discards credentials, and replace-navigates", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId })).mockImplementationOnce(() => json({ authenticated: true, operator: { displayName: "Pat", roles: ["eligibility_reviewer"] } }));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials); const otp = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(otp, { target: { value: "123456" } }); fireEvent.submit(screen.getByRole("form", { name: /sms verification/i }));
    expect(await screen.findByText("destination:/downtown-u/operator")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/123e4567|FFFF|323e4567/);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it.each([
    { displayName: "Pat", roles: ["admin"] },
    { displayName: "Pat", roles: ["audit_exporter", "audit_exporter"] },
    { displayName: " Pat ", roles: ["credit_adjuster"] },
    { displayName: "Pat\nAdmin", roles: ["reconciliation_operator"] },
    { displayName: "Pat", roles: ["eligibility_reviewer"], extra: true },
  ])("rejects invalid operator identity responses: %j", async (operator) => {
    const fetcher = vi.fn().mockImplementationOnce(() => json({ mfaRequired: true, smsChallengeId }))
      .mockImplementationOnce(() => json({ authenticated: true, operator }));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials); const otp = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(otp, { target: { value: "123456" } }); fireEvent.submit(screen.getByRole("form", { name: /sms verification/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not verify/i);
    expect(screen.queryByText(/destination:/i)).not.toBeInTheDocument();
  });
});

describe("resilience, session, and presentation", () => {
  it("redirects an exact existing session only when no fragment exists", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ authenticated: true, operator: { displayName: "Pat", roles: ["audit_exporter"] }, smsReauthFresh: false })));
    renderAuth(); expect(await screen.findByText("destination:/downtown-u/operator")).toBeInTheDocument();
  });

  it("rejects unknown roles in an existing session without rendering role codes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ authenticated: true, operator: { displayName: "Pat", roles: ["admin"] }, smsReauthFresh: false })));
    renderAuth();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.getByLabelText(/staff email/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("admin");
  });

  it.each([
    [new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })],
    [new Response(JSON.stringify({ mfaRequired: true, smsChallengeId, padding: "x".repeat(17000) }), { status: 200, headers: { "Content-Type": "application/json" } })],
    [new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })],
  ])("turns non-JSON, oversized, and malformed responses into generic failure", async (response) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response))); renderAuth(credentials);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not verify/i);
  });

  it("aborts a stalled verification at the bounded client timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetcher); renderAuth(credentials);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
    expect(screen.getByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("renders accessible compact staff UI with no h-screen or horizontal overflow classes", async () => {
    renderAuth(); const heading = screen.getByRole("heading", { name: /operator sign in/i });
    expect(heading).toHaveFocus();
    expect(screen.getByLabelText(/staff email/i)).toHaveAttribute("autocomplete", "email");
    expect(document.querySelector('[class~="min-h-[100dvh]"]')).toBeInTheDocument();
    expect(document.querySelector('[class*="h-screen"]')).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send sign-in link/i })).toHaveClass("min-h-11");
  });
});
