import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SmsReauthStep from "../SmsReauthStep";

const challengeId = "323e4567-e89b-42d3-a456-426614174000";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SMS reauthentication step", () => {
  it("propagates an exact challenge-issuance session 401 and clears the step", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => json({ authenticated: false }, 401)));
    const session = vi.fn();
    render(<SmsReauthStep onVerified={vi.fn()} onCancel={vi.fn()} onSession={session} />);
    await user.click(screen.getByRole("button", { name: "Send verification code" }));
    await waitFor(() => expect(session).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Six-digit verification code")).not.toBeInTheDocument();
  });

  it.each(["request", "verify"] as const)("aborts an in-flight %s on cancel without late callbacks or unhandled rejection", async (operation) => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    const pending = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    const fetcher = operation === "request"
      ? pending
      : vi.fn().mockImplementationOnce(() => json({ accepted: true, challengeId }, 202)).mockImplementationOnce(pending);
    vi.stubGlobal("fetch", fetcher);
    const verified = vi.fn(), cancelled = vi.fn();
    render(<SmsReauthStep onVerified={verified} onCancel={cancelled} onSession={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Send verification code" }));
    if (operation === "verify") {
      await user.type(await screen.findByLabelText("Six-digit verification code"), "012345");
      await user.click(screen.getByRole("button", { name: "Verify code" }));
    }
    await user.click(screen.getByRole("button", { name: "Cancel verification" }));
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(verified).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(/012345|couldn’t/i);
  });

  it("requests a challenge without identifying the phone, accepts exactly six numeric digits, and verifies accessibly", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => json({ accepted: true, challengeId }, 202))
      .mockImplementationOnce(() => json({ reauthenticated: true, validForSeconds: 300 }));
    vi.stubGlobal("fetch", fetcher);
    const verified = vi.fn();
    render(<SmsReauthStep onVerified={verified} onCancel={vi.fn()} onSession={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Send verification code" }));
    const otp = await screen.findByLabelText("Six-digit verification code");
    expect(otp).toHaveAttribute("inputmode", "numeric");
    expect(otp).toHaveAttribute("autocomplete", "one-time-code");
    expect(document.body).not.toHaveTextContent(challengeId);
    expect(document.body).not.toHaveTextContent(/phone|ending in|\*{2,}\d/i);
    expect(screen.getByRole("button", { name: "Verify code" })).toBeDisabled();
    await user.type(otp, "12a345");
    expect(otp).toHaveValue("12345");
    await user.clear(otp);
    await user.type(otp, "0123457");
    expect(otp).toHaveValue("012345");
    await user.click(screen.getByRole("button", { name: "Verify code" }));
    await waitFor(() => expect(verified).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenLastCalledWith("/api/downtown-u/operator/auth/reauth/verify", expect.objectContaining({
      body: JSON.stringify({ challengeId, otp: "012345" }),
    }));
    expect(screen.queryByDisplayValue("012345")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(challengeId);
  });

  it("is a single focus-contained step with 44px controls, generic live errors, retry, and cancellation cleanup", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => json({ accepted: true, challengeId }, 202))
      .mockImplementationOnce(() => json({ reauthenticated: false }, 401))
      .mockImplementationOnce(() => json({ reauthenticated: true, validForSeconds: 300 }));
    vi.stubGlobal("fetch", fetcher);
    const cancelled = vi.fn();
    const { unmount } = render(<SmsReauthStep onVerified={vi.fn()} onCancel={cancelled} onSession={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Send verification code" }));
    const otp = await screen.findByLabelText("Six-digit verification code");
    expect(otp).toHaveFocus();
    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("min-h-11");
    await user.type(otp, "123456");
    await user.click(screen.getByRole("button", { name: "Verify code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn’t verify that code");
    expect(document.body).not.toHaveTextContent(/challenge|123456|reauthenticated/i);
    expect(otp).toHaveValue("");
    expect(otp).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel verification" }));
    expect(cancelled).toHaveBeenCalledOnce();
    unmount();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });
});
