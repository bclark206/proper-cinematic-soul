import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, GraduationCap, Loader2, LogOut, RefreshCw, Utensils } from "lucide-react";
import {
  cancelReservation, createIdempotencyKey, DowntownUApiError, getMe, getMeals, getPurchases, getReservations,
  logout, requestMagicLink, reserveMeal, sendCode, verifyCode,
  type DowntownUMe, type DowntownUMeal, type DowntownUPurchase, type DowntownUReservation,
} from "./api";

type PortalState = "loading" | "authenticated" | "signed-out" | "unavailable";
type Tab = "meals" | "account" | "history";
type RetryReservation = { mealId: string; modifierIds: string[]; idempotencyKey: string };
type CancelAttempt = { reservationId: string; idempotencyKey: string };
const planNames = { "flex-5": "Flex 5", "scholar-10": "Scholar 10", "resident-20": "Resident 20", "semester-40": "Semester 40" } as const;

function publicMessage(error: unknown, action: "reserve" | "cancel" | "history"): string {
  if (!(error instanceof DowntownUApiError)) return action === "cancel"
    ? "We could not confirm the cancellation. Please retry."
    : action === "history" ? "We could not load more history. Please retry."
      : "We could not confirm your reservation. Please retry with the same selection.";
  if (error.kind === "insufficient-credits") return "There are not enough meal credits for this selection.";
  if (error.kind === "rate-limited") {
    const minutes = error.retryAfterSeconds ? Math.max(1, Math.ceil(error.retryAfterSeconds / 60)) : null;
    return minutes ? `Please try again in ${minutes} minutes.` : "Please wait a little while before trying again.";
  }
  if (error.kind === "forbidden") return "This action is not available for your account.";
  if (error.kind === "not-found") return action === "cancel" ? "This reservation is no longer available to cancel." : "That meal is no longer available.";
  if (error.kind === "conflict" || error.kind === "invalid-request") return action === "cancel"
    ? "This reservation can no longer be canceled." : "That selection is no longer available. Refresh the menu and try again.";
  return action === "cancel" ? "We could not confirm the cancellation. Please retry."
    : action === "history" ? "We could not load more history. Please retry."
      : "We could not confirm your reservation. Please retry with the same selection.";
}
const isAuthLoss = (error: unknown) => error instanceof DowntownUApiError && error.kind === "unauthorized";
const isRetryable = (error: unknown) => !(error instanceof DowntownUApiError) || ["network", "timeout", "unavailable", "rate-limited", "invalid-response"].includes(error.kind);
function formatUsd(cents: number): string {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100); }
  catch { return `$${(cents / 100).toFixed(2)}`; }
}

function LoadingPortal() {
  return <main className="min-h-screen overflow-x-hidden bg-[#090909] px-4 pb-16 pt-28 text-pure-white" aria-busy="true">
    <div className="mx-auto max-w-6xl" role="status" aria-live="polite">
      <span className="sr-only">Loading your Downtown U account</span>
      <div className="h-5 w-32 animate-pulse rounded bg-gold/20 motion-reduce:animate-none" />
      <div className="mt-5 h-14 max-w-xl animate-pulse rounded-xl bg-white/10 motion-reduce:animate-none" />
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((item) => <div key={item} className="h-44 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04] motion-reduce:animate-none" />)}
      </div>
    </div>
  </main>;
}

function SignIn({ onAuthenticated, invalidLink }: { onAuthenticated: () => Promise<void>; invalidLink: boolean }) {
  const [method, setMethod] = useState<"email" | "text">("email");
  const [email, setEmail] = useState(""); const [phone, setPhone] = useState("");
  const [showCode, setShowCode] = useState(false); const [challengeId, setChallengeId] = useState(""); const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [verifyError, setVerifyError] = useState("");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function request(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try { if (method === "email") await requestMagicLink(email); else await sendCode(phone); }
    catch { /* same public result prevents contact inference */ }
    finally {
      if (mounted.current) {
        setNotice(method === "email"
          ? "If the details match an eligible account, a secure sign-in link will arrive shortly."
          : "If the details match an eligible account, a text message with a code and sign-in reference will arrive shortly.");
        if (method === "text") setShowCode(true);
        setBusy(false);
      }
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); setBusy(true); setVerifyError("");
    try { await verifyCode(challengeId, code); await onAuthenticated(); }
    catch (error) {
      if (mounted.current) setVerifyError(error instanceof DowntownUApiError && ["unavailable", "timeout", "network"].includes(error.kind)
        ? "Verification is temporarily unavailable. Your code was not confirmed; please try again."
        : "We could not verify that code. Check the details or request a new code.");
    } finally { if (mounted.current) setBusy(false); }
  }
  function pasteReference(event: ClipboardEvent<HTMLInputElement>) {
    const value = event.clipboardData.getData("text");
    const reference = value.match(/(?:Sign-in reference:\s*)?([A-Za-z0-9_-]{43})/i)?.[1];
    if (!reference) return;
    event.preventDefault(); setChallengeId(reference);
    const pastedCode = value.match(/(?:code is\s*)?(\d{6})/i)?.[1];
    if (pastedCode) setCode(pastedCode);
  }

  return <main className="min-h-screen overflow-x-hidden bg-[#090909] px-4 pb-16 pt-24 text-pure-white sm:px-6 sm:pt-32">
    <div className="mx-auto grid max-w-5xl items-center gap-12 md:grid-cols-[1fr_1.05fr]">
      <section className="max-w-xl">
        <p className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] text-gold"><GraduationCap className="h-4 w-4" /> Downtown U</p>
        <h1 className="mt-4 font-display text-5xl font-bold leading-none sm:text-6xl">Your meals,<br /><span className="text-gold">ready for class.</span></h1>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-cream/65">Sign in to choose a meal, manage reservations, and see your meal-credit history.</p>
        <Link to="/downtown-u" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-cream/70 underline-offset-4 hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"><ArrowLeft className="h-4 w-4" /> About Downtown U</Link>
      </section>
      <section className="rounded-3xl border border-gold/25 bg-[#11110f] p-5 shadow-elegant sm:p-8" aria-labelledby="signin-title">
        <h2 id="signin-title" className="font-display text-3xl font-bold">Sign in to Downtown U</h2>
        <p className="mt-2 text-sm leading-relaxed text-cream/60">Use the email or mobile number connected to your approved account.</p>
        {invalidLink && <p role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">This sign-in link has expired or is invalid. Enter your email below to request a new link.</p>}
        <div className="mt-6 grid grid-cols-2 border-b border-white/10" role="group" aria-label="Sign-in method">
          <button type="button" aria-pressed={method === "email"} onClick={() => { setMethod("email"); setShowCode(false); setNotice(""); }} className={`min-h-12 border-b-2 px-3 font-semibold ${method === "email" ? "border-gold text-gold" : "border-transparent text-cream/55"}`}>Email a link</button>
          <button type="button" aria-pressed={method === "text"} onClick={() => { setMethod("text"); setNotice(""); }} className={`min-h-12 border-b-2 px-3 font-semibold ${method === "text" ? "border-gold text-gold" : "border-transparent text-cream/55"}`}>Text a code</button>
        </div>
        {!showCode ? <form className="mt-6 space-y-5" aria-label={method === "email" ? "Email sign-in" : "Text sign-in"} onSubmit={request}>
          {method === "email" ? <label className="block text-sm font-semibold">Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-white/15 bg-black/30 px-4 text-base text-white outline-none focus:border-gold focus:ring-2 focus:ring-gold/30" /></label>
            : <label className="block text-sm font-semibold">Mobile number<input required type="tel" inputMode="tel" autoComplete="tel" placeholder="+14435550123" pattern="\+[1-9][0-9]{7,14}" aria-describedby="phone-help" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[\s()-]/g, ""))} className="mt-2 min-h-12 w-full rounded-xl border border-white/15 bg-black/30 px-4 text-base text-white outline-none focus:border-gold focus:ring-2 focus:ring-gold/30" /><span id="phone-help" className="mt-2 block font-normal text-cream/50">Include the country code, for example +14435550123.</span></label>}
          <button disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gold px-4 font-bold text-jet-black disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{method === "email" ? "Send secure link" : "Send sign-in code"}</button>
        </form> : <form className="mt-6 space-y-5" aria-label="Verify text code" onSubmit={verify}>
          <p className="text-sm leading-relaxed text-cream/60">Paste the sign-in reference from the same text message, then enter its six-digit code. You can also paste the whole message into the reference field.</p>
          <label className="block text-sm font-semibold">Sign-in reference<input required minLength={43} maxLength={43} pattern="[A-Za-z0-9_-]{43}" autoComplete="off" spellCheck={false} onPaste={pasteReference} value={challengeId} onChange={(event) => setChallengeId(event.target.value.trim().slice(0, 43))} className="mt-2 min-h-12 w-full rounded-xl border border-white/15 bg-black/30 px-4 font-mono text-sm text-white outline-none focus:border-gold focus:ring-2 focus:ring-gold/30" /></label>
          <label className="block text-sm font-semibold">6-digit code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-2 min-h-14 w-full rounded-xl border border-white/15 bg-black/30 px-4 text-center font-mono text-2xl tracking-[0.35em] text-white outline-none focus:border-gold focus:ring-2 focus:ring-gold/30" /></label>
          <button disabled={busy || code.length !== 6 || challengeId.length !== 43} className="min-h-12 w-full rounded-xl bg-gold px-4 font-bold text-jet-black disabled:opacity-50">Verify and sign in</button>
          <button type="button" onClick={() => setShowCode(false)} className="min-h-11 w-full text-sm font-semibold text-cream/60 hover:text-gold">Request a new code</button>
        </form>}
        {method === "text" && !showCode && <button type="button" onClick={() => setShowCode(true)} className="mt-4 min-h-11 w-full text-sm font-semibold text-cream/60 underline-offset-4 hover:text-gold hover:underline">Already have a code?</button>}
        {notice && <p role="status" aria-live="polite" className="mt-5 rounded-xl border border-gold/20 bg-gold/[0.08] p-4 text-sm leading-relaxed text-cream">{notice}</p>}
        {verifyError && <p role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{verifyError}</p>}
      </section>
    </div>
  </main>;
}

function StatusPage({ retry }: { retry: () => void }) {
  return <main className="flex min-h-screen overflow-x-hidden bg-[#090909] px-4 py-24 text-pure-white"><section className="m-auto max-w-lg text-center">
    <p className="text-sm font-bold uppercase tracking-[.22em] text-gold">Downtown U</p><h1 className="mt-4 font-display text-4xl font-bold">Downtown U is temporarily unavailable</h1>
    <p className="mt-4 leading-relaxed text-cream/60">Your account has not been changed. Please try again in a moment.</p>
    <button type="button" onClick={retry} className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-xl bg-gold px-6 font-bold text-jet-black"><RefreshCw className="h-4 w-4" /> Try again</button>
  </section></main>;
}

function ReservationCard({ item, onCancel, busy }: { item: DowntownUReservation; onCancel: (id: string) => void; busy: boolean }) {
  return <article aria-label={`${item.mealName} reservation`} className="border-b border-white/10 py-5 first:pt-0 last:border-0">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-display text-xl font-bold">{item.mealName}</h4><p className="mt-1 text-sm text-cream/55">{new Date(item.reservedAt).toLocaleString()} · {item.credits} {item.credits === 1 ? "credit" : "credits"}</p></div>
      <span className="rounded-full border border-gold/25 px-3 py-1 text-xs font-bold uppercase tracking-wide text-gold">{item.status}</span></div>
    {item.modifiers.length > 0 && <p className="mt-2 text-sm text-cream/60">{item.modifiers.map((modifier) => modifier.name).join(", ")}</p>}
    {item.status === "reserved" && <button disabled={busy} type="button" onClick={() => onCancel(item.id)} className="mt-3 min-h-11 rounded-lg border border-white/15 px-4 text-sm font-semibold hover:border-gold hover:text-gold disabled:opacity-50">Cancel reservation</button>}
  </article>;
}

export default function DowntownUPortal() {
  const location = useLocation(); const navigate = useNavigate();
  const [invalidLink] = useState(() => {
    const routeState = location.state as { authFailure?: unknown } | null;
    return routeState?.authFailure === "invalid";
  });
  const [state, setState] = useState<PortalState>("loading"); const [tab, setTab] = useState<Tab>("meals");
  const [me, setMe] = useState<DowntownUMe | null>(null); const [meals, setMeals] = useState<DowntownUMeal[]>([]);
  const [purchases, setPurchases] = useState<DowntownUPurchase[]>([]); const [reservations, setReservations] = useState<DowntownUReservation[]>([]);
  const [purchaseCursor, setPurchaseCursor] = useState<string | null>(null); const [reservationCursor, setReservationCursor] = useState<string | null>(null);
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null); const [modifierIds, setModifierIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [confirmed, setConfirmed] = useState<DowntownUReservation | null>(null);
  const [balanceRefreshPending, setBalanceRefreshPending] = useState(false);
  const [reservationAttempt, setReservationAttempt] = useState<RetryReservation | null>(null); const [cancelAttempt, setCancelAttempt] = useState<CancelAttempt | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resetProtected = useCallback(() => {
    setMe(null); setMeals([]); setPurchases([]); setReservations([]); setPurchaseCursor(null); setReservationCursor(null);
    setSelectedMealId(null); setModifierIds([]); setConfirmed(null); setReservationAttempt(null); setCancelAttempt(null);
    setMessage(""); setBalanceRefreshPending(false); setTab("meals"); setBusy(false); setState("signed-out");
  }, []);
  const load = useCallback(async () => {
    setState("loading"); setMessage("");
    try {
      const account = await getMe();
      const [menu, purchasePage, reservationPage] = await Promise.all([getMeals(), getPurchases(), getReservations()]);
      setMe(account); setMeals(menu.items); setPurchases(purchasePage.items); setPurchaseCursor(purchasePage.nextCursor);
      setReservations(reservationPage.items); setReservationCursor(reservationPage.nextCursor); setState("authenticated");
    } catch (error) { if (isAuthLoss(error)) resetProtected(); else setState("unavailable"); }
  }, [resetProtected]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (invalidLink) navigate(location.pathname, { replace: true, state: null });
  }, [invalidLink, location.pathname, navigate]);
  useEffect(() => { if (state === "authenticated") headingRef.current?.focus(); }, [state]);

  const selectedMeal = meals.find((meal) => meal.id === selectedMealId) ?? null;
  const selectedModifiers = useMemo(() => selectedMeal?.modifiers.filter((modifier) => modifierIds.includes(modifier.id)) ?? [], [selectedMeal, modifierIds]);
  const total = selectedMeal ? selectedMeal.baseCredits + selectedModifiers.reduce((sum, modifier) => sum + modifier.creditDelta, 0) : 0;
  const validTotal = total >= 1 && total <= 40;
  function selectMeal(meal: DowntownUMeal) { setReservationAttempt(null); setCancelAttempt(null); setSelectedMealId(meal.id); setModifierIds([]); setConfirmed(null); setBalanceRefreshPending(false); setMessage(""); }
  function toggleModifier(id: string) {
    setReservationAttempt(null); setCancelAttempt(null); setConfirmed(null); setMessage("");
    setModifierIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 10 ? [...current, id] : current);
  }

  async function runReservation(attempt?: RetryReservation) {
    if (!selectedMeal && !attempt) return;
    if (!attempt && !validTotal) return;
    const unchangedAttempt = reservationAttempt?.mealId === selectedMeal?.id
      && reservationAttempt.modifierIds.length === modifierIds.length
      && reservationAttempt.modifierIds.every((id, index) => id === modifierIds[index]) ? reservationAttempt : null;
    const next = attempt ?? unchangedAttempt ?? { mealId: selectedMeal!.id, modifierIds: [...modifierIds], idempotencyKey: createIdempotencyKey() };
    setCancelAttempt(null); setReservationAttempt(next); setBusy(true); setMessage(""); setBalanceRefreshPending(false);
    try {
      const result = await reserveMeal(next); setConfirmed(result); setReservations((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      setReservationAttempt(null); setModifierIds([]); setSelectedMealId(null);
      try { setMe(await getMe()); }
      catch (refreshError) {
        if (isAuthLoss(refreshError)) { resetProtected(); return; }
        setBalanceRefreshPending(true);
      }
    } catch (error) {
      if (isAuthLoss(error)) { resetProtected(); return; }
      setMessage(publicMessage(error, "reserve")); if (!isRetryable(error)) setReservationAttempt(null);
    } finally { setBusy(false); }
  }
  async function runCancel(reservationId: string, attempt?: CancelAttempt) {
    const next = attempt ?? (cancelAttempt?.reservationId === reservationId ? cancelAttempt : null)
      ?? { reservationId, idempotencyKey: createIdempotencyKey() };
    setReservationAttempt(null); setCancelAttempt(next); setConfirmed(null); setBusy(true); setMessage("");
    try {
      const result = await cancelReservation(next.reservationId, next.idempotencyKey);
      setReservations((current) => current.map((item) => item.id === result.id ? result : item)); setCancelAttempt(null); setMessage("Reservation canceled.");
      try { setMe(await getMe()); setBalanceRefreshPending(false); }
      catch (refreshError) {
        if (isAuthLoss(refreshError)) { resetProtected(); return; }
        setBalanceRefreshPending(true);
      }
    } catch (error) {
      if (isAuthLoss(error)) { resetProtected(); return; }
      setMessage(publicMessage(error, "cancel")); if (!isRetryable(error)) setCancelAttempt(null);
    } finally { setBusy(false); }
  }
  async function more(kind: "purchases" | "reservations") {
    setBusy(true); setMessage("");
    try {
      if (kind === "purchases" && purchaseCursor) { const page = await getPurchases(purchaseCursor); setPurchases((items) => [...items, ...page.items]); setPurchaseCursor(page.nextCursor); }
      if (kind === "reservations" && reservationCursor) { const page = await getReservations(reservationCursor); setReservations((items) => [...items, ...page.items]); setReservationCursor(page.nextCursor); }
    } catch (error) { if (isAuthLoss(error)) resetProtected(); else setMessage(publicMessage(error, "history")); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true);
    try { await logout(); } catch { /* server logout responses clear the scoped cookie before reporting failure */ }
    finally { resetProtected(); }
  }

  if (state === "loading") return <LoadingPortal />;
  if (state === "signed-out") return <SignIn onAuthenticated={load} invalidLink={invalidLink} />;
  if (state === "unavailable") return <StatusPage retry={() => void load()} />;
  if (!me) return null;

  return <div className="min-h-screen overflow-x-hidden bg-[#090909] text-pure-white">
    <header className="border-b border-white/10 bg-[#0d0d0d] px-4 py-5 sm:px-6"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
      <Link to="/downtown-u" className="font-display text-2xl font-bold text-gold">Proper Cuisine <span className="ml-2 font-body text-xs uppercase tracking-[.18em] text-cream/50">Downtown U</span></Link>
      <button type="button" disabled={busy} onClick={() => void signOut()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-semibold hover:border-gold hover:text-gold"><LogOut className="h-4 w-4" /> Sign out</button>
    </div></header>
    <main className="overflow-x-hidden px-4 pb-20 pt-9 sm:px-6"><div className="mx-auto max-w-6xl">
      <section className="grid gap-7 border-b border-white/10 pb-8 md:grid-cols-[1fr_auto] md:items-end">
        <div><p className="text-sm font-bold uppercase tracking-[.22em] text-gold">Student meal portal</p><h1 ref={headingRef} tabIndex={-1} className="mt-2 font-display text-4xl font-bold outline-none sm:text-5xl">What sounds Proper?</h1><p className="mt-3 max-w-xl text-cream/60">Choose from today’s eligible meals and reserve with your available credits.</p></div>
        <div className="border-l-2 border-gold pl-5"><p className="text-3xl font-bold text-gold">{me.availableCredits} meal credits</p><p className="mt-1 text-sm text-cream/50">available now</p></div>
      </section>
      <nav aria-label="Portal sections" className="-mx-4 flex overflow-x-auto border-b border-white/10 px-4 sm:mx-0 sm:px-0">
        {(["meals", "account", "history"] as const).map((item) => <button key={item} type="button" aria-current={tab === item ? "page" : undefined} onClick={() => { setTab(item); setMessage(""); setReservationAttempt(null); setCancelAttempt(null); if (item !== "meals") { setConfirmed(null); setBalanceRefreshPending(false); } }} className={`min-h-14 shrink-0 border-b-2 px-5 text-sm font-bold capitalize ${tab === item ? "border-gold text-gold" : "border-transparent text-cream/55 hover:text-white"}`}>{item}</button>)}
      </nav>
      {message && <div role={message === "Reservation canceled." ? "status" : "alert"} aria-live="polite" className="mt-6 rounded-xl border border-gold/25 bg-gold/[0.08] p-4 text-sm text-cream">{message}
        {reservationAttempt && <button type="button" disabled={busy} onClick={() => void runReservation(reservationAttempt)} className="ml-3 min-h-10 font-bold text-gold underline">Retry reservation</button>}
        {cancelAttempt && <button type="button" disabled={busy} onClick={() => void runCancel(cancelAttempt.reservationId, cancelAttempt)} className="ml-3 min-h-10 font-bold text-gold underline">Retry cancellation</button>}
      </div>}
      {tab === "meals" && confirmed && <section className="mt-7 border-l-2 border-gold bg-gold/[0.06] p-5" aria-live="polite"><Check className="h-6 w-6 text-gold" /><h2 className="mt-2 font-display text-2xl font-bold">Reservation confirmed</h2><p className="mt-1 text-cream/60">{confirmed.mealName} · {confirmed.credits} credits</p><p className="mt-2 text-sm text-cream/50">Reserved until {new Date(confirmed.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>{balanceRefreshPending && <p className="mt-3 text-sm text-cream/65">Your reservation is confirmed. The displayed balance has not refreshed yet.</p>}</section>}
      {balanceRefreshPending && !confirmed && <p role="status" className="mt-5 text-sm text-cream/65">Your account change is confirmed. The displayed balance has not refreshed yet.</p>}

      {tab === "meals" && <section className="py-9" aria-labelledby="meals-title"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-gold">Available now</p><h2 id="meals-title" className="mt-2 font-display text-3xl font-bold">Choose your meal</h2></div><Utensils className="h-7 w-7 text-gold/50" /></div>
        {meals.length === 0 ? <p className="mt-8 border-l-2 border-white/15 pl-4 text-cream/60">No meals are available right now. Please check back later.</p> : <div className="mt-7 divide-y divide-white/10 border-y border-white/10">{meals.map((meal) => <article key={meal.id} className="grid gap-5 py-6 md:grid-cols-[1fr_auto] md:items-center"><div><h3 className="font-display text-2xl font-bold">{meal.name}</h3><p className="mt-1 text-sm font-semibold text-gold">{meal.baseCredits} {meal.baseCredits === 1 ? "credit" : "credits"}</p></div><button type="button" onClick={() => selectMeal(meal)} disabled={busy} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-gold/40 px-5 font-bold text-gold hover:bg-gold hover:text-jet-black disabled:opacity-50 md:w-auto">Choose {meal.name}<ChevronRight className="h-4 w-4" /></button>
          {selectedMealId === meal.id && <div className="md:col-span-2 border-l-2 border-gold bg-white/[0.03] p-4 sm:p-6"><h4 className="font-display text-xl font-bold">Make it yours</h4>{meal.modifiers.length === 0 ? <p className="mt-2 text-sm text-cream/55">No changes are available for this meal.</p> : <fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="sr-only">Meal modifiers, choose up to 10</legend>{meal.modifiers.map((modifier) => <label key={modifier.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-white/10 px-4 text-sm hover:border-gold/40"><input type="checkbox" checked={modifierIds.includes(modifier.id)} disabled={busy || (!modifierIds.includes(modifier.id) && modifierIds.length >= 10)} onChange={() => toggleModifier(modifier.id)} className="h-4 w-4 accent-[hsl(var(--gold))]" /><span className="flex-1">{modifier.name}</span><span className="font-bold text-gold">{modifier.creditDelta > 0 ? `+${modifier.creditDelta}` : modifier.creditDelta} {Math.abs(modifier.creditDelta) === 1 ? "credit" : "credits"}</span></label>)}</fieldset>}
            <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-cream">Total: {total} {total === 1 ? "credit" : "credits"}</p>{!validTotal && <p id={`total-error-${meal.id}`} role="alert" className="mt-1 text-sm text-red-200">Reservations must total between 1 and 40 credits. Change your selections to continue.</p>}</div><button disabled={busy || !validTotal} aria-describedby={!validTotal ? `total-error-${meal.id}` : undefined} onClick={() => void runReservation()} className="min-h-12 rounded-xl bg-gold px-6 font-bold text-jet-black disabled:opacity-50">{busy ? "Reserving…" : `Reserve for ${total} ${total === 1 ? "credit" : "credits"}`}</button></div>
          </div>}</article>)}</div>}
        <p className="mt-6 text-sm leading-relaxed text-cream/45">Tell the team about allergies at pickup. Our kitchen handles common allergens, and cross-contact is possible.</p>
      </section>}

      {tab === "account" && <section className="py-9" aria-labelledby="account-title"><p className="text-xs font-bold uppercase tracking-[.2em] text-gold">Your account</p><h2 id="account-title" className="mt-2 font-display text-3xl font-bold">Meal-credit summary</h2>
        <div className="mt-8 grid gap-8 md:grid-cols-2"><div className="border-l-2 border-gold pl-5"><p className="text-sm text-cream/50">Available balance</p><p className="mt-1 text-4xl font-bold">{me.availableCredits}</p><p className="text-sm text-cream/55">meal credits</p></div><div className="border-l border-white/15 pl-5"><p className="text-sm text-cream/50">Active plan</p>{me.activePlan ? <><p className="mt-1 font-display text-2xl font-bold">{planNames[me.activePlan.planId]}</p><p className="mt-1 text-sm text-cream/55">{me.activePlan.creditsGranted} credits granted · active since {new Date(me.activePlan.paidAt).toLocaleDateString()}</p></> : <p className="mt-1 text-lg text-cream/65">No active plan</p>}</div></div>
        <div className="mt-10 border-t border-white/10 pt-6"><h3 className="font-display text-xl font-bold">Sign-in details</h3><p className="mt-3 break-words text-sm text-cream/60">{me.email ?? me.phone ?? "Contact details unavailable"}</p></div>
      </section>}

      {tab === "history" && <section className="grid gap-12 py-9 md:grid-cols-2" aria-labelledby="history-title"><h2 id="history-title" className="sr-only">Account history</h2><div><h3 className="font-display text-2xl font-bold">Reservations</h3><div className="mt-5">{reservations.length === 0 ? <p className="text-cream/55">No reservations yet.</p> : reservations.map((item) => <ReservationCard key={item.id} item={item} busy={busy} onCancel={(id) => void runCancel(id)} />)}</div>{reservationCursor && <button disabled={busy} onClick={() => void more("reservations")} className="mt-5 min-h-11 font-bold text-gold underline underline-offset-4">Load more reservations</button>}</div>
        <div><h3 className="font-display text-2xl font-bold">Plan purchases</h3><div className="mt-5">{purchases.length === 0 ? <p className="text-cream/55">No plan purchases yet.</p> : purchases.map((item) => <article key={item.id} className="border-b border-white/10 py-5 first:pt-0"><div className="flex justify-between gap-3"><div><h4 className="font-display text-xl font-bold">{planNames[item.planId]}</h4><p className="mt-1 text-sm text-cream/55">{new Date(item.paidAt).toLocaleDateString()} · {item.creditsGranted} credits</p></div><p className="font-bold text-gold">{formatUsd(item.priceCents)}</p></div>{item.refundedCredits > 0 && <p className="mt-2 text-sm text-cream/55">{item.refundedCredits} credits refunded</p>}</article>)}</div>{purchaseCursor && <button disabled={busy} onClick={() => void more("purchases")} className="mt-5 min-h-11 font-bold text-gold underline underline-offset-4">Load more purchases</button>}</div>
      </section>}
    </div></main>
    <footer className="border-t border-white/10 px-4 py-6 text-center text-xs text-cream/40"><p>Downtown U by Proper Cuisine · 206 E Redwood St, Baltimore</p></footer>
  </div>;
}
