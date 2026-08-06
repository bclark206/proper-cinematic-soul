import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import SmsReauthStep from "./SmsReauthStep";
import {
  canonicalizeEligibilityReason,
  EligibilityMutationRequestError,
  newEligibilityIdempotencyKey,
  submitEligibilityDecision,
  type EligibilityDecision,
  type EligibilityReasonCode,
  type EligibilityResult,
} from "./eligibility-mutation-api";
import { controlClass } from "./shared";
import type { Student } from "./types";

const labels: Record<EligibilityDecision, string> = { approve: "Approve", reject: "Reject", suspend: "Suspend", reinstate: "Reinstate" };
const effects: Record<EligibilityDecision, string> = {
  approve: "Approving will mark this student eligible for Downtown U benefits.",
  reject: "Rejecting will mark this student ineligible for Downtown U benefits.",
  suspend: "Suspending will pause this student’s Downtown U eligibility.",
  reinstate: "Reinstating will restore this student’s Downtown U eligibility.",
};
const reasons: Record<EligibilityDecision, [EligibilityReasonCode, string][]> = {
  approve: [["documentation_verified", "Documentation verified"]],
  reject: [["documentation_incomplete", "Documentation incomplete"], ["policy_ineligible", "Policy ineligible"]],
  suspend: [["safety_hold", "Safety hold"], ["policy_hold", "Policy hold"]],
  reinstate: [["hold_cleared", "Hold cleared"]],
};
type Step = "edit" | "review" | "reauth" | "stale" | "error" | "submitting";

interface Props {
  student: Student;
  decision: EligibilityDecision;
  sessionFresh: boolean;
  onOpenChange: (open: boolean) => void;
  refetchStudent: () => Promise<Student | null>;
  onSuccess: (result: EligibilityResult) => void;
  onSession: () => void;
  onForbidden: () => void;
}

export default function EligibilityMutationDialog({ student, decision, sessionFresh, onOpenChange, refetchStudent, onSuccess, onSession, onForbidden }: Props) {
  const client = useQueryClient();
  const [step, setStep] = useState<Step>("edit");
  const [code, setCode] = useState<EligibilityReasonCode | "">("");
  const [note, setNote] = useState("");
  const [canonical, setCanonical] = useState("");
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const key = useRef<{ signature: string; value: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => () => {
    mounted.current = false;
    opener.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (step !== "reauth") heading.current?.focus();
  }, [step]);

  const close = () => {
    if (step === "submitting") return;
    opener.current?.focus();
    onOpenChange(false);
  };
  const review = () => {
    try {
      const value = canonicalizeEligibilityReason(decision, code as EligibilityReasonCode, note);
      setCanonical(value);
      setNote(value);
      setError("");
      setStep("review");
    } catch {
      setError("Enter a valid note and select a reason.");
    }
  };
  const afterVerify = async () => {
    client.setQueryData(["operator", "session"], (current: unknown) => {
      if (!current || typeof current !== "object") return current;
      return { ...current, smsReauthFresh: true };
    });
    void client.invalidateQueries({ queryKey: ["operator", "session"], exact: true, refetchType: "none" }).catch(() => undefined);
    let latest: Student | null = null;
    try {
      latest = await refetchStudent();
    } catch {
      // A decision cannot proceed if current state cannot be confirmed.
    }
    if (!mounted.current) return;
    if (!latest || latest.updatedAt !== student.updatedAt || latest.eligibilityStatus !== student.eligibilityStatus) {
      setStep("stale");
      return;
    }
    setVerified(true);
    setError("");
    setStep("review");
  };
  const continueFromReview = () => {
    if (sessionFresh || verified) void submit();
    else setStep("reauth");
  };
  const submit = async () => {
    if (step !== "review" && step !== "error") return;
    const body = {
      studentId: student.id,
      expectedStatus: student.eligibilityStatus,
      expectedUpdatedAt: new Date(student.updatedAt).toISOString(),
      decision,
      reasonCode: code as EligibilityReasonCode,
      reason: canonical,
    };
    const signature = JSON.stringify(body);
    if (!key.current || key.current.signature !== signature) key.current = { signature, value: newEligibilityIdempotencyKey() };
    setStep("submitting");
    setError("");
    let authoritative: EligibilityResult;
    try {
      const response = await submitEligibilityDecision(body, key.current.value);
      authoritative = response.result;
    } catch (caught) {
      if (!mounted.current) return;
      const kind = caught instanceof EligibilityMutationRequestError ? caught.kind : "unavailable";
      if (kind === "reauth") {
        setVerified(false);
        setStep("reauth");
        return;
      }
      if (kind === "conflict") {
        void refetchStudent().catch(() => null);
        setStep("stale");
        return;
      }
      if (kind === "session") {
        close();
        onSession();
        return;
      }
      if (kind === "forbidden") {
        close();
        onForbidden();
        return;
      }
      setError("Decision unavailable. Your draft is safe; try again.");
      setStep("error");
      return;
    }
    try {
      onSuccess(authoritative);
    } catch {
      // The authoritative response was accepted; callback failures are not mutation failures.
    }
  };

  const commitLabel = `${labels[decision]} student eligibility`;
  const reviewButton = sessionFresh || verified ? commitLabel : "Continue to verification";

  return <Dialog.Root open onOpenChange={(open) => { if (!open && step !== "submitting") close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
      <Dialog.Content
        aria-label={commitLabel}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); heading.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (step === "submitting") event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (step === "submitting") event.preventDefault(); }}
        onInteractOutside={(event) => { if (step === "submitting") event.preventDefault(); }}
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-[#837b6b] bg-[#eee7d8] p-5 text-[#1b1a17] shadow-2xl sm:p-7"
      >
        <Dialog.Title className="sr-only">{commitLabel}</Dialog.Title>
        {step === "reauth" ? <SmsReauthStep onVerified={afterVerify} onCancel={close} onSession={onSession} /> : step === "stale" ? <section>
          <h2 ref={heading} tabIndex={-1} className="font-display text-2xl font-semibold outline-none">Review latest</h2>
          <p role="alert" className="mt-4 border-l-4 border-[#8d2e25] bg-[#fff4e8] p-3 text-sm font-semibold">The student record changed. Review the latest status before making a new decision.</p>
          <p className="mt-4 text-sm">Your decision note remains: <span className="font-semibold">{canonical}</span></p>
          <button type="button" className="mt-5 min-h-11 rounded-md bg-[#1b1a17] px-4 text-sm font-semibold text-[#fff9eb]" onClick={close}>Review latest</button>
        </section> : <section>
          <h2 ref={heading} tabIndex={-1} className="font-display text-2xl font-semibold outline-none">{step === "edit" ? "Edit decision" : "Review decision"}</h2>
          <p className="mt-2 text-sm text-[#5c574d]">{labels[decision]} eligibility for this student.</p>
          {error && <p role="alert" className="mt-4 border-l-4 border-[#8d2e25] bg-[#fff4e8] p-3 text-sm font-semibold">{error}</p>}
          {step === "edit" ? <div className="mt-5 space-y-5">
            <div>
              <label htmlFor="decision-reason" className="mb-2 block text-sm font-semibold">Reason</label>
              <select id="decision-reason" className={controlClass} value={code} onChange={(event) => setCode(event.target.value as EligibilityReasonCode)}>
                <option value="">Select a reason</option>
                {reasons[decision].map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="decision-note" className="mb-2 block text-sm font-semibold">Decision note</label>
              <textarea id="decision-note" className={`${controlClass} min-h-28 py-3`} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
              <p className="mt-2 text-xs leading-5 text-[#5c574d]">Use 1–500 Unicode characters (scalars). Do not include contact, payment, health, or other sensitive information.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="min-h-11 rounded-md bg-[#1b1a17] px-4 text-sm font-semibold text-[#fff9eb]" onClick={review}>Review decision</button>
              <button type="button" className="min-h-11 rounded-md border border-[#837b6b] px-4 text-sm font-semibold" onClick={close}>Cancel</button>
            </div>
          </div> : <div className="mt-5">
            <p className="border-l-4 border-[#8b743d] bg-[#fffaf0] p-3 text-sm font-semibold">{effects[decision]}</p>
            <dl className="mt-4 space-y-3 text-sm"><div><dt className="font-semibold">Decision note</dt><dd className="break-words">{canonical}</dd></div></dl>
            {step === "submitting" && <p role="status" className="mt-4 font-semibold">Submitting decision…</p>}
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" disabled={step === "submitting"} className="min-h-11 rounded-md bg-[#1b1a17] px-4 text-sm font-semibold text-[#fff9eb] disabled:opacity-50" onClick={continueFromReview}>{step === "error" ? "Try again" : reviewButton}</button>
              <button type="button" disabled={step === "submitting"} className="min-h-11 rounded-md border border-[#837b6b] px-4 text-sm font-semibold disabled:opacity-50" onClick={() => { setError(""); setStep("edit"); }}>Edit decision</button>
              <button type="button" disabled={step === "submitting"} className="min-h-11 rounded-md border border-[#837b6b] px-4 text-sm font-semibold disabled:opacity-50" onClick={close}>Cancel</button>
            </div>
          </div>}
        </section>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
