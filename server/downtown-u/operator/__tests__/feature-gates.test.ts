import { describe, expect, it } from "vitest";
import { operatorFeatureGatesFromEnvironment } from "../feature-gates";

describe("operator feature gates", () => {
  it.each([
    undefined, "", "0", "true", "TRUE", "yes", "01", "1 ", " 1", 1, true, null,
  ])("treats malformed enabled value %j as disabled", (value) => {
    expect(operatorFeatureGatesFromEnvironment({ DOWNTOWN_U_OPERATOR_ENABLED: value })).toEqual({
      enabled: false,
      mutationsEnabled: false,
      exportsEnabled: false,
    });
  });

  it("enables the surface only for exact string 1", () => {
    expect(operatorFeatureGatesFromEnvironment({ DOWNTOWN_U_OPERATOR_ENABLED: "1" })).toEqual({
      enabled: true,
      mutationsEnabled: false,
      exportsEnabled: false,
    });
  });

  it("requires the main gate as well as each exact capability gate", () => {
    expect(operatorFeatureGatesFromEnvironment({
      DOWNTOWN_U_OPERATOR_ENABLED: "0",
      DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: "1",
      DOWNTOWN_U_OPERATOR_EXPORTS_ENABLED: "1",
    })).toEqual({ enabled: false, mutationsEnabled: false, exportsEnabled: false });

    expect(operatorFeatureGatesFromEnvironment({
      DOWNTOWN_U_OPERATOR_ENABLED: "1",
      DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: "1",
      DOWNTOWN_U_OPERATOR_EXPORTS_ENABLED: "1",
    })).toEqual({ enabled: true, mutationsEnabled: true, exportsEnabled: true });
  });

  it.each([
    ["DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED", "mutationsEnabled"],
    ["DOWNTOWN_U_OPERATOR_EXPORTS_ENABLED", "exportsEnabled"],
  ] as const)("accepts only exact string 1 for %s", (environmentKey, resultKey) => {
    for (const value of [undefined, "", "0", "true", "01", "1 ", 1, true, null]) {
      const gates = operatorFeatureGatesFromEnvironment({
        DOWNTOWN_U_OPERATOR_ENABLED: "1",
        [environmentKey]: value,
      });
      expect(gates[resultKey]).toBe(false);
    }
  });

  it("fails closed for missing, null, primitive, and malformed environments", () => {
    for (const env of [undefined, null, "1", 1, true, Symbol("env")]) {
      expect(operatorFeatureGatesFromEnvironment(env)).toEqual({
        enabled: false,
        mutationsEnabled: false,
        exportsEnabled: false,
      });
    }
  });

  it("ignores prototype flags and accessors without invoking getters", () => {
    let getterCalls = 0;
    const prototype = {
      DOWNTOWN_U_OPERATOR_ENABLED: "1",
      DOWNTOWN_U_OPERATOR_MUTATIONS_ENABLED: "1",
      DOWNTOWN_U_OPERATOR_EXPORTS_ENABLED: "1",
    };
    const env = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperty(env, "DOWNTOWN_U_OPERATOR_ENABLED", {
      enumerable: true,
      get: () => { getterCalls += 1; return "1"; },
    });

    expect(operatorFeatureGatesFromEnvironment(env)).toEqual({
      enabled: false,
      mutationsEnabled: false,
      exportsEnabled: false,
    });
    expect(getterCalls).toBe(0);
  });

  it("returns a frozen gate snapshot", () => {
    const gates = operatorFeatureGatesFromEnvironment({ DOWNTOWN_U_OPERATOR_ENABLED: "1" });
    expect(Object.isFrozen(gates)).toBe(true);
  });

  it("reuses one immutable result for every disabled outcome", () => {
    const missing = operatorFeatureGatesFromEnvironment(undefined);
    const explicitlyDisabled = operatorFeatureGatesFromEnvironment({
      DOWNTOWN_U_OPERATOR_ENABLED: "0",
    });

    expect(missing).toBe(explicitlyDisabled);
    expect(Object.isFrozen(missing)).toBe(true);
  });
});
