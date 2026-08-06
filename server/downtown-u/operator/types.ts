export const OPERATOR_ROLES = Object.freeze([
  "eligibility_reviewer",
  "reconciliation_operator",
  "credit_adjuster",
  "audit_exporter",
] as const);

export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const OPERATOR_ACCOUNT_STATUSES = Object.freeze(["active", "disabled"] as const);
export type OperatorAccountStatus = (typeof OPERATOR_ACCOUNT_STATUSES)[number];

export const OPERATOR_ELIGIBILITY_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const);
export type OperatorEligibilityStatus = (typeof OPERATOR_ELIGIBILITY_STATUSES)[number];

/** The only student fields permitted to cross an operator service boundary. */
export interface RedactedOperatorStudent {
  readonly id: string;
  readonly eligibilityStatus: OperatorEligibilityStatus;
  readonly maskedEmail?: string;
  readonly maskedPhone?: string;
  readonly eligibilityReviewedAt?: string;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly suspendedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
}

export interface OperatorFeatureGates {
  readonly enabled: boolean;
  readonly mutationsEnabled: boolean;
  readonly exportsEnabled: boolean;
}