export const OPERATOR_ROLES = ["eligibility_reviewer", "reconciliation_operator", "credit_adjuster", "audit_exporter"] as const;
export type OperatorRole = typeof OPERATOR_ROLES[number];
export interface OperatorSession { authenticated: true; operator: { displayName: string; roles: OperatorRole[] }; smsReauthFresh: boolean }
export type Endpoint = "students" | "purchases" | "redemptions" | "reconciliation";
export type EligibilityStatus = "pending" | "approved" | "rejected" | "suspended";
export type PurchaseStatus = "paid" | "partially_refunded" | "refunded";
export type RedemptionStatus = "reserved" | "redeemed" | "reversed" | "cancelled";
export type ReconciliationState = "needs_review" | "resolved";
export type ReconciliationCategory = "payment_follow_up" | "kitchen_follow_up";
export interface Student { id: string; eligibilityStatus: EligibilityStatus; maskedEmail?: string; maskedPhone?: string; eligibilityReviewedAt?: string; approvedAt?: string; rejectedAt?: string; suspendedAt?: string; createdAt: string; updatedAt: string; deletedAt?: string }
export interface Purchase { id: string; studentId: string; planId: "flex-5"|"scholar-10"|"resident-20"|"semester-40"; creditsGranted: number; priceCents: number; currency: "USD"; status: PurchaseStatus; refundedCredits: number; paidAt: string; refundedAt?: string; createdAt: string; updatedAt: string }
export interface Redemption { id: string; studentId: string; mealName: string; credits: number; status: RedemptionStatus; reservedAt: string; expiresAt?: string; redeemedAt?: string; reversedAt?: string; createdAt: string; updatedAt: string }
export interface Reconciliation { id: string; studentId: string; category: ReconciliationCategory; state: ReconciliationState; openedAt: string; resolvedAt?: string }
export interface EndpointMap { students: Student; purchases: Purchase; redemptions: Redemption; reconciliation: Reconciliation }
export type Filters = Record<string, string>;
export interface ListResponse<E extends Endpoint> { items: EndpointMap[E][]; nextCursor: string | null }
