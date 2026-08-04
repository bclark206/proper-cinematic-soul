export const DOWNTOWN_U_PAYMENT_LINK_ENV_KEYS = {
  "flex-5": "VITE_DOWNTOWN_U_FLEX_5_URL",
  "scholar-10": "VITE_DOWNTOWN_U_SCHOLAR_10_URL",
  "resident-20": "VITE_DOWNTOWN_U_RESIDENT_20_URL",
  "semester-40": "VITE_DOWNTOWN_U_SEMESTER_40_URL",
} as const;

export type DowntownUPlanId = keyof typeof DOWNTOWN_U_PAYMENT_LINK_ENV_KEYS;
type PublicEnvironment = Record<string, string | boolean | undefined>;

const SQUARE_PAYMENT_HOSTS = new Set(["square.link", "checkout.square.site"]);

const isAllowedSquarePaymentUrl = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value !== value.trim() ||
    value.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) return false;

  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  if (!authority || authority.includes(":")) return false;

  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname);
    if (/[\p{Cc}\p{Cf}]/u.test(decodedPath)) return false;

    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      SQUARE_PAYMENT_HOSTS.has(url.hostname.toLowerCase()) &&
      url.pathname !== "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

/**
 * Returns the complete set or nothing. A partial/malformed deployment must not
 * silently expose some plans or redirect buyers away from Square.
 */
export const getDowntownUPaymentLinks = (
  environment: PublicEnvironment,
): ReadonlyMap<DowntownUPlanId, string> | null => {
  const links = new Map<DowntownUPlanId, string>();
  const uniqueUrls = new Set<string>();
  for (const [planId, environmentKey] of Object.entries(DOWNTOWN_U_PAYMENT_LINK_ENV_KEYS) as [
    DowntownUPlanId,
    (typeof DOWNTOWN_U_PAYMENT_LINK_ENV_KEYS)[DowntownUPlanId],
  ][]) {
    const value = environment[environmentKey];
    if (!isAllowedSquarePaymentUrl(value) || uniqueUrls.has(value)) return null;
    uniqueUrls.add(value);
    links.set(planId, value);
  }
  return links;
};

export const downtownUPaymentLinks = getDowntownUPaymentLinks(import.meta.env);
