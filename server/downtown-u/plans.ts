export const DOWNTOWN_U_PLANS = {
  "flex-5": { id: "flex-5", credits: 5, priceCents: 6_000 },
  "scholar-10": { id: "scholar-10", credits: 10, priceCents: 11_000 },
  "resident-20": { id: "resident-20", credits: 20, priceCents: 21_000 },
  "semester-40": { id: "semester-40", credits: 40, priceCents: 40_000 },
} as const;

export type DowntownUPlanId = keyof typeof DOWNTOWN_U_PLANS;
export type DowntownUPlan = (typeof DOWNTOWN_U_PLANS)[DowntownUPlanId];

export function getCanonicalPlan(id: unknown): DowntownUPlan {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(DOWNTOWN_U_PLANS, id)) {
    throw new Error("Unknown Downtown U plan");
  }
  return DOWNTOWN_U_PLANS[id as DowntownUPlanId];
}
