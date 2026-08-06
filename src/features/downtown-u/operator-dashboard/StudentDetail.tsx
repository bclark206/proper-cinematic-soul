import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OperatorRequestError, readOperatorList, UUID } from "./api";
import EligibilityMutationDialog from "./EligibilityMutationDialog";
import type { EligibilityDecision, EligibilityResult } from "./eligibility-mutation-api";
import { DateValue, Loading, Notice, PageHeading, human } from "./shared";
import { useOperatorSession } from "./session";
import type { Student } from "./types";

const transitions: Record<Student["eligibilityStatus"], EligibilityDecision[]> = {
  pending: ["approve", "reject"], approved: ["suspend"], suspended: ["reinstate"], rejected: [],
};
const actionLabel: Record<EligibilityDecision, string> = {
  approve: "Approve", reject: "Reject", suspend: "Suspend", reinstate: "Reinstate",
};

export default function StudentDetail() {
  const { studentId = "" } = useParams();
  const { session, endSession } = useOperatorSession();
  const client = useQueryClient();
  const [decision, setDecision] = useState<EligibilityDecision | null>(null);
  const [success, setSuccess] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const successRef = useRef<HTMLDivElement>(null);
  const decisionOpener = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  const canonical = UUID.test(studentId);
  const reviewer = session.operator.roles.includes("eligibility_reviewer");
  const exactKey = ["operator", "students", "detail", studentId] as const;
  const query = useQuery({
    queryKey: exactKey,
    queryFn: async () => {
      const result = await readOperatorList("students", { studentId }, null);
      return result.items.length === 1 ? result.items[0] : null;
    },
    enabled: canonical && reviewer,
    retry: false,
  });
  const sessionFailure = query.error instanceof OperatorRequestError && query.error.kind === "session";

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (sessionFailure) endSession();
  }, [endSession, sessionFailure]);
  useLayoutEffect(() => {
    if (!success) return;
    const frame = requestAnimationFrame(() => successRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [success]);
  useLayoutEffect(() => {
    if (!decision) decisionOpener.current?.focus();
  }, [decision]);

  if (!canonical || !reviewer) return <><PageHeading description="This student review route is unavailable.">Access unavailable</PageHeading><Notice title="Limited access">Return to a section shown in the navigation.</Notice></>;
  // Fail closed immediately, including when React Query still has protected cached data.
  if (sessionFailure) return null;
  if (query.isPending) return <><PageHeading description="Loading the current student record.">Loading student</PageHeading><Loading /></>;
  if (query.isError && !query.data) return <><PageHeading description="The current student record could not be loaded.">Student eligibility</PageHeading><Notice role="alert" title="Record unavailable" retry={() => void query.refetch()}>We couldn’t load this student. Try again.</Notice></>;
  if (!query.data) return <><PageHeading description="The requested student record is not available.">Student not found</PageHeading><Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/downtown-u/operator/students">Back to students</Link></>;

  const student = query.data;
  if (student.deletedAt) {
    return <>
      <PageHeading description="This student record is archived and read-only.">Archived student</PageHeading>
      <Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/downtown-u/operator/students">Back to students</Link>
      <Notice title="Archived record">Eligibility decisions are unavailable for archived students.</Notice>
      <section className="mt-5 border border-[#c2b7a2] bg-[#fffaf0] p-5">
        <StudentFields student={student} />
      </section>
    </>;
  }

  const refetch = async () => {
    const result = await query.refetch();
    return result.data ?? null;
  };
  const succeeded = (result: EligibilityResult) => {
    const authoritative: Student = {
      id: result.studentId,
      eligibilityStatus: result.eligibilityStatus,
      eligibilityReviewedAt: result.eligibilityReviewedAt,
      updatedAt: result.updatedAt,
      createdAt: student.createdAt,
      ...(student.maskedEmail ? { maskedEmail: student.maskedEmail } : {}),
      ...(student.maskedPhone ? { maskedPhone: student.maskedPhone } : {}),
      ...(result.approvedAt ? { approvedAt: result.approvedAt } : {}),
      ...(result.rejectedAt ? { rejectedAt: result.rejectedAt } : {}),
      ...(result.suspendedAt ? { suspendedAt: result.suspendedAt } : {}),
    };
    // Cache reconciliation survives route/component unmount after the request began.
    client.setQueryData(exactKey, authoritative);
    if (mounted.current) {
      setSuccess(`Eligibility ${result.eligibilityStatus}`);
      setDecision(null);
    }
    const listKey = ["operator", "students"] as const;
    const tasks: Promise<unknown>[] = [
      client.invalidateQueries({ queryKey: exactKey, refetchType: "none" }),
      client.invalidateQueries({ queryKey: listKey, exact: false, refetchType: "none" }),
    ];
    if (mounted.current) tasks.push(
      client.refetchQueries({ queryKey: exactKey, exact: true, type: "active" }),
      client.refetchQueries({ queryKey: listKey, exact: false, type: "all" }),
    );
    void Promise.all(tasks.map((task) => task.catch(() => undefined))).catch(() => undefined);
  };

  return <>
    <PageHeading description="Review the current eligibility state and masked contact details.">Student eligibility</PageHeading>
    <Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/downtown-u/operator/students">Back to students</Link>
    {success && <div ref={successRef} tabIndex={-1} role="status" aria-label={success} className="mt-4 border-l-4 border-[#58724a] bg-[#fffaf0] p-4 font-semibold outline-none">{success}</div>}
    {forbidden && <div role="alert" className="mt-4 border-l-4 border-[#8d2e25] bg-[#fff4e8] p-4 font-semibold">Eligibility access changed. Decision controls were removed.</div>}
    <section className="mt-5 border border-[#c2b7a2] bg-[#fffaf0] p-5">
      <StudentFields student={student} />
      {!forbidden && transitions[student.eligibilityStatus].length > 0 && <div className="mt-6 flex flex-wrap gap-2 border-t border-[#d1c6b1] pt-5">
        {transitions[student.eligibilityStatus].map((action) => <button key={action} type="button" className="min-h-11 rounded-md bg-[#1b1a17] px-5 text-sm font-semibold text-[#fff9eb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b743d] focus-visible:ring-offset-2" onClick={(event) => { decisionOpener.current = event.currentTarget; setDecision(action); }}>{actionLabel[action]}</button>)}
      </div>}
    </section>
    {decision && <EligibilityMutationDialog student={student} decision={decision} sessionFresh={session.smsReauthFresh} onOpenChange={(open) => { if (!open) setDecision(null); }} refetchStudent={refetch} onSuccess={succeeded} onSession={endSession} onForbidden={() => { setForbidden(true); void client.refetchQueries({ queryKey: ["operator", "session"] }); }} />}
  </>;
}

function StudentFields({ student }: { student: Student }) {
  return <dl className="grid gap-4 sm:grid-cols-2">
    <Item label="Student ID">{student.id}</Item>
    <Item label="Status">{human(student.eligibilityStatus)}</Item>
    {student.maskedEmail && <Item label="Masked email">{student.maskedEmail}</Item>}
    {student.maskedPhone && <Item label="Masked phone"><span className="whitespace-nowrap">{student.maskedPhone}</span></Item>}
    <Item label="Updated"><DateValue value={student.updatedAt} /></Item>
    {student.deletedAt && <Item label="Archived"><DateValue value={student.deletedAt} /></Item>}
  </dl>;
}
function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-bold uppercase tracking-wide text-[#665f53]">{label}</dt><dd className="mt-1 min-w-0 break-words text-sm">{children}</dd></div>;
}
