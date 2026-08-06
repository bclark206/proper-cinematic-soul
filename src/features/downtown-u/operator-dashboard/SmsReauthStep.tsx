import { useEffect, useRef, useState } from "react";
import { EligibilityMutationRequestError, requestSmsReauth, verifySmsReauth } from "./eligibility-mutation-api";
import { controlClass } from "./shared";

export default function SmsReauthStep({ onVerified, onCancel, onSession }: { onVerified: () => void | Promise<void>; onCancel: () => void; onSession: () => void }) {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    heading.current?.focus();
    return () => {
      mounted.current = false;
      cancelled.current = true;
      operation.current?.abort();
      operation.current = null;
    };
  }, []);
  useEffect(() => { if (challenge) input.current?.focus(); }, [challenge]);

  const begin = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    return controller;
  };
  const isActive = (controller: AbortController) => mounted.current && !cancelled.current && operation.current === controller && !controller.signal.aborted;
  const finish = (controller: AbortController) => {
    const active = isActive(controller);
    if (operation.current === controller) operation.current = null;
    if (active) setBusy(false);
  };

  const issue = async () => {
    if (busy) return;
    cancelled.current = false;
    const controller = begin();
    setBusy(true);
    setError("");
    try {
      const result = await requestSmsReauth(controller.signal);
      if (!isActive(controller)) return;
      setChallenge(result.challengeId);
      setOtp("");
    } catch (caught) {
      if (!isActive(controller)) return;
      if (caught instanceof EligibilityMutationRequestError && caught.kind === "session") {
        cancelled.current = true;
        operation.current = null;
        try { onSession(); } catch { /* Session teardown is terminal for this step. */ }
        return;
      }
      setError("We couldn’t send a code. Try again.");
    } finally {
      finish(controller);
    }
  };

  const verify = async () => {
    if (busy || !challenge || otp.length !== 6) return;
    const controller = begin();
    setBusy(true);
    setError("");
    try {
      await verifySmsReauth(challenge, otp, controller.signal);
      if (!isActive(controller)) return;
      setOtp("");
      setChallenge(null);
      operation.current = null;
      await onVerified();
    } catch {
      if (!isActive(controller)) return;
      setOtp("");
      setError("We couldn’t verify that code. Try again.");
      queueMicrotask(() => { if (mounted.current && !cancelled.current) input.current?.focus(); });
    } finally {
      finish(controller);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setOtp("");
    setChallenge(null);
    setError("");
    onCancel();
  };

  return <section aria-labelledby="reauth-title">
    <h2 ref={heading} id="reauth-title" tabIndex={-1} className="font-display text-2xl font-semibold outline-none">Verify your access</h2>
    <p className="mt-2 text-sm leading-6 text-[#5c574d]">For this sensitive decision, confirm your staff access with a one-time code.</p>
    {error && <p role="alert" aria-live="assertive" className="mt-4 border-l-4 border-[#8d2e25] bg-[#fff4e8] p-3 text-sm font-semibold">{error}</p>}
    {!challenge
      ? <button type="button" disabled={busy} onClick={() => void issue()} className="mt-5 min-h-11 rounded-md bg-[#1b1a17] px-4 text-sm font-semibold text-[#fff9eb] disabled:opacity-50">{busy ? "Sending…" : "Send verification code"}</button>
      : <div className="mt-5">
        <label htmlFor="eligibility-otp" className="mb-2 block text-sm font-semibold">Six-digit verification code</label>
        <input ref={input} id="eligibility-otp" className={controlClass} value={otp} inputMode="numeric" autoComplete="one-time-code" maxLength={6} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button type="button" disabled={busy || otp.length !== 6} onClick={() => void verify()} className="mt-4 min-h-11 rounded-md bg-[#1b1a17] px-4 text-sm font-semibold text-[#fff9eb] disabled:opacity-50">{busy ? "Verifying…" : "Verify code"}</button>
      </div>}
    <button type="button" onClick={cancel} className="ml-2 mt-4 min-h-11 rounded-md border border-[#837b6b] px-4 text-sm font-semibold">Cancel verification</button>
  </section>;
}
