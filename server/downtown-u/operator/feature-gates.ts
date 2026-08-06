import type { OperatorFeatureGates } from "./types";

const DISABLED_GATES: OperatorFeatureGates = Object.freeze({
  enabled: false,
  mutationsEnabled: false,
  exportsEnabled: false,
});

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a frozen snapshot. Capabilities cannot bypass the deployment-wide gate. */
export function operatorFeatureGatesFromEnvironment(
  env: unknown = process.env,
): OperatorFeatureGates {
  if (typeof env !== "object" || env === null) return DISABLED_GATES;

  const enabled = ownDataProperty(env, "DOWNTOWN_U_OPERATOR_ENABLED") === "1";
  if (!enabled) return DISABLED_GATES;

  return Object.freeze({
    enabled: true,
    mutationsEnabled: ownDataProperty(env, "DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED") === "1",
    exportsEnabled: ownDataProperty(env, "DOWNTOWN_U_OPERATOR_EXPORTS_ENABLED") === "1",
  });
}