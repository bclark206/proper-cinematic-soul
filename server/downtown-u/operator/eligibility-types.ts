import { exactOwnData, isCanonicalLowercaseUuid } from "./trusted-result";

export const ELIGIBILITY_DECISIONS = ["approve", "reject", "suspend", "reinstate"] as const;
export const ELIGIBILITY_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type OperatorEligibilityDecision = typeof ELIGIBILITY_DECISIONS[number];
export type OperatorEligibilityStatus = typeof ELIGIBILITY_STATUSES[number];
export type OperatorEligibilityReasonCode =
  | "documentation_verified" | "documentation_incomplete" | "policy_ineligible"
  | "safety_hold" | "policy_hold" | "hold_cleared";

export interface OperatorEligibilityMutationBody {
  readonly studentId: string;
  readonly expectedStatus: OperatorEligibilityStatus;
  readonly expectedUpdatedAt: string;
  readonly decision: OperatorEligibilityDecision;
  readonly reasonCode: OperatorEligibilityReasonCode;
  readonly reason: string;
}
export interface OperatorEligibilityMutationItem {
  readonly studentId: string;
  readonly eligibilityStatus: Exclude<OperatorEligibilityStatus, "pending">;
  readonly eligibilityReviewedAt: string;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly suspendedAt?: string;
  readonly updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRANSITIONS = new Set([
  "approve|pending|documentation_verified",
  "reject|pending|documentation_incomplete", "reject|pending|policy_ineligible",
  "suspend|approved|safety_hold", "suspend|approved|policy_hold",
  "reinstate|suspended|hold_cleared",
]);

const plainOwnData = exactOwnData;
export function isCanonicalUuid(value: unknown): value is string { return isCanonicalLowercaseUuid(value) && UUID.test(value); }
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function isCanonicalReason(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value !== value.normalize("NFC")) return false;
  let scalars = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    scalars++;
  }
  if (scalars < 1 || scalars > 500) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}
export function validateEligibilityMutationBody(value: unknown): OperatorEligibilityMutationBody {
  const body = plainOwnData(value, ["studentId", "expectedStatus", "expectedUpdatedAt", "decision", "reasonCode", "reason"]);
  if (!body || !isCanonicalUuid(body.studentId) || !isCanonicalTimestamp(body.expectedUpdatedAt)
    || typeof body.expectedStatus !== "string" || typeof body.decision !== "string" || typeof body.reasonCode !== "string"
    || !TRANSITIONS.has(`${body.decision}|${body.expectedStatus}|${body.reasonCode}`) || !isCanonicalReason(body.reason)) {
    throw new TypeError("Invalid operator eligibility mutation");
  }
  return Object.freeze({
    studentId: body.studentId,
    expectedStatus: body.expectedStatus as OperatorEligibilityStatus,
    expectedUpdatedAt: body.expectedUpdatedAt,
    decision: body.decision as OperatorEligibilityDecision,
    reasonCode: body.reasonCode as OperatorEligibilityReasonCode,
    reason: body.reason,
  });
}

export function validateEligibilityMutationItem(value: unknown): OperatorEligibilityMutationItem {
  const common = ["studentId", "eligibilityStatus", "eligibilityReviewedAt", "updatedAt"];
  const shapes = [
    [...common, "approvedAt"],
    [...common, "rejectedAt"],
    [...common, "approvedAt", "suspendedAt"],
  ];
  const row = shapes.map((shape) => exactOwnData(value, shape)).find((candidate) => candidate !== undefined);
  if (!row) throw new TypeError("Invalid operator eligibility result");
  if (!isCanonicalUuid(row.studentId) || !isCanonicalTimestamp(row.eligibilityReviewedAt) || !isCanonicalTimestamp(row.updatedAt)
    || !["approved", "rejected", "suspended"].includes(String(row.eligibilityStatus))) throw new TypeError("Invalid operator eligibility result");
  for (const key of ["approvedAt", "rejectedAt", "suspendedAt"]) if (key in row && !isCanonicalTimestamp(row[key])) throw new TypeError("Invalid operator eligibility result");
  if (row.eligibilityStatus === "approved" && (!("approvedAt" in row) || "rejectedAt" in row || "suspendedAt" in row)) throw new TypeError("Invalid operator eligibility result");
  if (row.eligibilityStatus === "rejected" && (!("rejectedAt" in row) || "approvedAt" in row || "suspendedAt" in row)) throw new TypeError("Invalid operator eligibility result");
  if (row.eligibilityStatus === "suspended" && (!("suspendedAt" in row) || !("approvedAt" in row) || "rejectedAt" in row)) throw new TypeError("Invalid operator eligibility result");
  const output: Record<string, string> = {};
  for (const key of ["studentId", "eligibilityStatus", "eligibilityReviewedAt", "approvedAt", "rejectedAt", "suspendedAt", "updatedAt"])
    if (key in row) output[key] = row[key] as string;
  return Object.freeze(output) as unknown as OperatorEligibilityMutationItem;
}
