import { OperatorAuthBoundaryError } from "./auth-http";
import {
  isCanonicalUuid,
  type OperatorReadEndpoint,
  type ReadFilters,
} from "./read-types";

export interface ParsedReadQuery {
  limit: number;
  cursor: string | null;
  filters: ReadFilters;
}

const enums = {
  students: { eligibilityStatus: ["pending", "approved", "rejected", "suspended"] },
  purchases: { status: ["paid", "partially_refunded", "refunded"] },
  redemptions: { status: ["reserved", "redeemed", "reversed", "cancelled"] },
  reconciliation: {
    state: ["needs_review", "resolved"],
    category: ["payment_follow_up", "kitchen_follow_up"],
  },
} as const;

const keys = {
  students: ["limit", "cursor", "eligibilityStatus", "studentId"],
  purchases: ["limit", "cursor", "status", "studentId", "purchaseId"],
  redemptions: ["limit", "cursor", "status", "studentId", "redemptionId"],
  reconciliation: ["limit", "cursor", "state", "category", "studentId", "caseId"],
} as const;

function bad(): never {
  throw new OperatorAuthBoundaryError();
}

function hasControlOrSpace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/** Parses only the relative, canonical URL form emitted by the dashboard client. */
export function parseOperatorReadQuery(
  endpoint: OperatorReadEndpoint,
  raw: unknown,
): ParsedReadQuery {
  const expectedPath = `/api/downtown-u/operator/${endpoint}`;
  if (
    typeof raw !== "string"
    || raw.length < expectedPath.length
    || Buffer.byteLength(raw, "utf8") > 2_048
    || hasControlOrSpace(raw)
    || !raw.startsWith(expectedPath)
    || (raw.length > expectedPath.length && raw[expectedPath.length] !== "?")
  ) bad();

  let url: URL;
  try {
    url = new URL(raw, "https://operator.invalid");
  } catch {
    return bad();
  }
  if (
    url.origin !== "https://operator.invalid"
    || url.hash !== ""
    || url.pathname !== expectedPath
    || url.search.includes("%")
  ) bad();

  const allowed = keys[endpoint] as readonly string[];
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) bad();
    seen.add(key);
  }

  const value = (key: string): string | null =>
    url.searchParams.has(key) ? url.searchParams.get(key) : null;
  const rawLimit = value("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9]\d|100)$/.test(rawLimit)) bad();

  const cursor = value("cursor");
  if (
    cursor !== null
    && (cursor.length < 3 || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))
  ) bad();

  const uuid = (key: string): string | null => {
    const candidate = value(key);
    if (candidate !== null && !isCanonicalUuid(candidate)) bad();
    return candidate;
  };
  const pick = (key: string, allowedValues: readonly string[]): string | null => {
    const candidate = value(key);
    if (candidate !== null && !allowedValues.includes(candidate)) bad();
    return candidate;
  };

  let filters: ReadFilters;
  if (endpoint === "students") {
    filters = {
      eligibilityStatus: pick("eligibilityStatus", enums.students.eligibilityStatus),
      studentId: uuid("studentId"),
    };
  } else if (endpoint === "purchases") {
    filters = {
      status: pick("status", enums.purchases.status),
      studentId: uuid("studentId"),
      purchaseId: uuid("purchaseId"),
    };
  } else if (endpoint === "redemptions") {
    filters = {
      status: pick("status", enums.redemptions.status),
      studentId: uuid("studentId"),
      redemptionId: uuid("redemptionId"),
    };
  } else {
    filters = {
      state: pick("state", enums.reconciliation.state),
      category: pick("category", enums.reconciliation.category),
      studentId: uuid("studentId"),
      caseId: uuid("caseId"),
    };
  }

  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor, filters };
}
