import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { consumeOperatorAuthFragment, type OperatorLinkCredentials } from "./fragment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const OTP = /^[0-9]{6}$/;
const RESPONSE_LIMIT = 16 * 1024;
const TIMEOUT_MS = 8_000;
const AUTH_ROOT = "/api/downtown-u/operator/auth";
const DESTINATION = "/downtown-u/operator";
const OPERATOR_ROLES = new Set([
  "eligibility_reviewer",
  "reconciliation_operator",
  "credit_adjuster",
  "audit_exporter",
]);
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

class TemporaryRequestError extends Error {}


function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}


async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("invalid response");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) throw new Error("invalid response");
  if (!response.body) throw new Error("invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("invalid response"); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new Error("invalid response"); }
}

async function requestJson(path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${AUTH_ROOT}/${path}`, {
        method,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      throw new TemporaryRequestError();
    }
    return { status: response.status, body: await readBoundedJson(response) };
  } finally { window.clearTimeout(timer); }
}

function validEmailSuccess(value: unknown): value is { mfaRequired: true; smsChallengeId: string } {
  return exactKeys(value, ["mfaRequired", "smsChallengeId"])
    && value.mfaRequired === true && typeof value.smsChallengeId === "string" && UUID.test(value.smsChallengeId);
}
function validSmsSuccess(value: unknown): boolean {
  if (!exactKeys(value, ["authenticated", "operator"]) || value.authenticated !== true
    || !exactKeys(value.operator, ["displayName", "roles"])) return false;
  const displayName = value.operator.displayName;
  const roles = value.operator.roles;
  return typeof displayName === "string" && displayName.length >= 1 && displayName.length <= 120
    && displayName.trim() === displayName && !hasControlCharacter(displayName)
    && Array.isArray(roles) && roles.length <= 4
    && new Set(roles).size === roles.length
    && roles.every((role) => typeof role === "string" && OPERATOR_ROLES.has(role));
}
function validSession(value: unknown): boolean {
  return exactKeys(value, ["authenticated", "operator", "smsReauthFresh"])
    && value.authenticated === true && typeof value.smsReauthFresh === "boolean"
    && validSmsSuccess({ authenticated: true, operator: value.operator });
}

type Stage = "email" | "email-sent" | "verifying-link" | "otp" | "invalid-link" | "link-unavailable";
interface OperatorAuthProps { initialCredentials?: OperatorLinkCredentials | null; invalidFragment?: boolean }

export default function OperatorAuth({ initialCredentials, invalidFragment = false }: OperatorAuthProps) {
  const navigate = useNavigate();
  const initial = useRef(invalidFragment ? { kind: "invalid" as const } : initialCredentials === undefined ? consumeOperatorAuthFragment() :
    initialCredentials === null ? { kind: "none" as const } : { kind: "valid" as const, credentials: initialCredentials });
  const [stage, setStage] = useState<Stage>(initial.current.kind === "valid" ? "verifying-link" : initial.current.kind === "invalid" ? "invalid-link" : "email");
  const [flow, setFlow] = useState<{ flowId: string; flowVerifier: string; smsChallengeId: string } | null>(null);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const linkCredentialsRef = useRef<OperatorLinkCredentials | null>(initial.current.kind === "valid" ? initial.current.credentials : null);
  const linkRequestActiveRef = useRef(false);
  const mountedRef = useRef(true);

  useLayoutEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { if (stage === "otp") otpRef.current?.focus(); }, [stage]);

  const verifyLink = useCallback(async () => {
    const link = linkCredentialsRef.current;
    if (!link || linkRequestActiveRef.current) return;
    linkRequestActiveRef.current = true;
    setStage("verifying-link");
    try {
      const response = await requestJson("verify-email", "POST", link);
      if (!mountedRef.current) return;
      if (response.status === 200 && validEmailSuccess(response.body)) {
        setFlow({ flowId: link.flowId, flowVerifier: link.flowVerifier, smsChallengeId: response.body.smsChallengeId });
        linkCredentialsRef.current = null;
        initial.current = { kind: "none" };
        setStage("otp");
      } else if (response.status === 503) {
        setStage("link-unavailable");
      } else {
        linkCredentialsRef.current = null;
        initial.current = { kind: "none" };
        setStage("invalid-link");
      }
    } catch (requestError) {
      if (!mountedRef.current) return;
      if (requestError instanceof TemporaryRequestError) {
        setStage("link-unavailable");
      } else {
        linkCredentialsRef.current = null;
        initial.current = { kind: "none" };
        setStage("invalid-link");
      }
    } finally {
      linkRequestActiveRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (initial.current.kind === "valid") void verifyLink();
  }, [verifyLink]);

  useEffect(() => () => {
    mountedRef.current = false;
    linkCredentialsRef.current = null;
    initial.current = { kind: "none" };
  }, []);

  useEffect(() => {
    if (initial.current.kind !== "none" || stage !== "email") return;
    let active = true;
    void requestJson("session", "GET").then((response) => {
      if (active && response.status === 200 && validSession(response.body)) navigate(DESTINATION, { replace: true });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [navigate, stage]);

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const normalized = email.trim().toLowerCase().normalize("NFC");
    if (normalized.length > 254 || !EMAIL.test(normalized)) { setError("Enter a valid email address."); return; }
    setEmail(normalized); setError(""); setBusy(true);
    try { await requestJson("request-link", "POST", { email: normalized }); } catch { /* Enumeration-safe by design. */ }
    setBusy(false); setStage("email-sent");
  };

  const submitOtp = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !flow) return;
    if (!OTP.test(otp)) { setError("Enter the six-digit code from the text message."); return; }
    setBusy(true); setError("");
    try {
      const response = await requestJson("verify-sms", "POST", { flowId: flow.flowId, flowVerifier: flow.flowVerifier, challengeId: flow.smsChallengeId, otp });
      if (response.status === 200 && validSmsSuccess(response.body)) {
        setFlow(null); setOtp(""); navigate(DESTINATION, { replace: true }); return;
      }
      setError(response.status === 503 ? "Sign-in is temporarily unavailable. Try again." : response.status === 401
        ? "That code is invalid or expired. Check the message and try again." : "We could not verify that code. Try again.");
    } catch { setError("We could not verify that code. Try again."); }
    setBusy(false);
  };

  const startAgain = () => {
    linkCredentialsRef.current = null; initial.current = { kind: "none" };
    setFlow(null); setOtp(""); setError(""); setStage("email");
  };
  const retryLink = () => { void verifyLink(); };
  const inputClass = "min-h-11 w-full rounded-md border border-[#6d685e] bg-[#fffaf0] px-3 text-base text-[#171715] outline-none focus-visible:ring-2 focus-visible:ring-[#b7a46f] focus-visible:ring-offset-2 focus-visible:ring-offset-[#171715]";
  const buttonClass = "min-h-11 w-full rounded-md bg-[#c6b27a] px-4 py-2.5 text-sm font-semibold text-[#171715] hover:bg-[#d2c08d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4eddd] focus-visible:ring-offset-2 focus-visible:ring-offset-[#171715] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

  return <main className="min-h-[100dvh] w-full overflow-x-hidden bg-[#171715] px-4 py-8 text-[#f4eddd] sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] lg:items-center lg:gap-16 lg:px-[8vw]">
    <section className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-md flex-col justify-center lg:col-start-2 lg:min-h-0">
      <div className="mb-8 flex items-center gap-3" aria-label="Downtown U staff">
        <span className="grid h-9 w-9 place-items-center rounded-full border border-[#c6b27a] text-xs font-bold tracking-wider">DU</span>
        <div><p className="text-sm font-semibold tracking-[0.14em]">DOWNTOWN U</p><p className="text-xs text-[#bdb6a8]">Staff access</p></div>
      </div>
      <div className="border-t border-[#4a4740] pt-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#c6b27a]">Secure access</p>
        <h1 ref={headingRef} tabIndex={-1} className="font-body text-3xl font-semibold tracking-tight outline-none sm:text-4xl">Operator sign in</h1>
        <p className="mt-3 max-w-sm text-sm leading-6 text-[#bdb6a8]">Use your approved staff email. No password is required.</p>

        {stage === "verifying-link" && <div role="status" aria-live="polite" className="mt-8 border-l-2 border-[#c6b27a] pl-4 text-sm">Verifying your secure link…</div>}
        {stage === "email" && <form aria-label="Email sign-in" onSubmit={submitEmail} className="mt-8 space-y-5" noValidate>
          <div><label htmlFor="operator-email" className="mb-2 block text-sm font-medium">Staff email</label><input id="operator-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} disabled={busy} aria-describedby={error ? "operator-error" : undefined} /></div>
          {error && <p id="operator-error" role="alert" className="text-sm text-[#f1a69b]">{error}</p>}
          <button type="submit" className={buttonClass} disabled={busy} aria-busy={busy}>{busy ? "Sending…" : "Send sign-in link"}</button>
        </form>}
        {stage === "email-sent" && <div className="mt-8" role="status" aria-label="Email sent"><h2 className="font-body text-xl font-semibold">Check your email</h2><p className="mt-2 text-sm leading-6 text-[#bdb6a8]">If the address is approved, a secure sign-in link will arrive shortly. You can close this page.</p></div>}
        {stage === "otp" && <form aria-label="SMS verification" onSubmit={submitOtp} className="mt-8 space-y-5" noValidate>
          <div><label htmlFor="operator-otp" className="mb-2 block text-sm font-medium">Six-digit code</label><input ref={otpRef} id="operator-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} className={`${inputClass} tracking-[0.35em]`} disabled={busy} aria-describedby={error ? "operator-error" : "otp-help"} /><p id="otp-help" className="mt-2 text-xs text-[#bdb6a8]">Enter the code sent to your staff mobile number.</p></div>
          {error && <p id="operator-error" role="alert" className="text-sm text-[#f1a69b]">{error}</p>}
          <button type="submit" className={buttonClass} disabled={busy} aria-busy={busy}>{busy ? "Verifying…" : "Verify and sign in"}</button>
        </form>}
        {(stage === "invalid-link" || stage === "link-unavailable") && <div className="mt-8 space-y-5">
          <p role="alert" className="border-l-2 border-[#c6b27a] pl-4 text-sm leading-6">{stage === "link-unavailable" ? "Sign-in is temporarily unavailable. Your link was safely removed from this browser." : "We could not verify this link. It may be invalid or expired."}</p>
          <button type="button" className={buttonClass} onClick={stage === "link-unavailable" ? retryLink : startAgain}>{stage === "link-unavailable" ? "Try again" : "Start again"}</button>
        </div>}
      </div>
      <p className="mt-10 text-xs leading-5 text-[#8f897d]">Restricted to authorized Downtown U staff. Sign-in activity may be monitored.</p>
    </section>
    <aside className="hidden border-l border-[#34322e] pl-12 lg:block lg:col-start-1 lg:row-start-1" aria-hidden="true"><p className="max-w-xs text-sm leading-7 text-[#8f897d]">OPERATIONS<br />STUDENT SERVICES<br />DOWNTOWN U</p></aside>
  </main>;
}
