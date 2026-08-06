const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFIER = /^[A-Za-z0-9_-]{43}$/;
const AUTH_PATH = "/downtown-u/operator/auth";
const LEGACY_PREFIX = `#${AUTH_PATH}?`;
const EXPECTED_FIELDS = ["flowId", "flowVerifier", "challengeId", "verifier"] as const;

export interface OperatorLinkCredentials {
  flowId: string;
  flowVerifier: string;
  challengeId: string;
  verifier: string;
}
export type FragmentResult = { kind: "none" } | { kind: "invalid" } | { kind: "valid"; credentials: OperatorLinkCredentials };

function parseCredentials(rawParameters: string): FragmentResult {
  const parameters = new URLSearchParams(rawParameters);
  const names = [...parameters.keys()];
  const uniqueAndExact = names.length === EXPECTED_FIELDS.length
    && new Set(names).size === EXPECTED_FIELDS.length
    && EXPECTED_FIELDS.every((name) => names.includes(name));
  if (!uniqueAndExact) return { kind: "invalid" };

  const candidate = {
    flowId: parameters.get("flowId") ?? "",
    flowVerifier: parameters.get("flowVerifier") ?? "",
    challengeId: parameters.get("challengeId") ?? "",
    verifier: parameters.get("verifier") ?? "",
  };
  return UUID.test(candidate.flowId) && VERIFIER.test(candidate.flowVerifier)
    && UUID.test(candidate.challengeId) && VERIFIER.test(candidate.verifier)
    ? { kind: "valid", credentials: candidate }
    : { kind: "invalid" };
}

/** Consume delivery credentials at the first synchronous UI boundary. */
export function consumeOperatorAuthFragment(): FragmentResult {
  const { pathname, hash } = window.location;
  const canonical = pathname === AUTH_PATH && hash.length > 0;
  const legacy = pathname === "/" && hash.startsWith(LEGACY_PREFIX);
  if (!canonical && !legacy) return { kind: "none" };

  const result = parseCredentials(canonical ? hash.slice(1) : hash.slice(LEGACY_PREFIX.length));
  // Clear every fragment byte before any effect, fetch, render, storage, or log.
  // Canonical links preserve their exact BrowserRouter pathname; bounded legacy
  // links are upgraded to that same route.
  window.history.replaceState(window.history.state, "", canonical ? pathname : AUTH_PATH);
  return result;
}
