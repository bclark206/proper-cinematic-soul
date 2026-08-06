import { types } from "node:util";

const CANONICAL_LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_PROTOTYPE = Date.prototype;
const DATE_GET_TIME = Date.prototype.getTime;

/**
 * Copies an exact plain/null-prototype record only after its complete shape has
 * been checked. Proxies are rejected before any operation that could invoke a
 * trap, and accessor values are never evaluated.
 */
export function exactOwnData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || keys.some((key) => !names.includes(key))) return undefined;

  const descriptors: PropertyDescriptor[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    descriptors.push(descriptor);
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  keys.forEach((key, index) => { output[key] = descriptors[index].value; });
  return output;
}

/** A trap-free prerequisite for any reflection over an untrusted object. */
export function isUnproxiedObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !types.isProxy(value);
}

export function isCanonicalLowercaseUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_LOWERCASE_UUID.test(value);
}

/** Returns finite epoch milliseconds only for an exact, non-proxy native Date. */
export function exactDateTime(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  if (Object.getPrototypeOf(value) !== DATE_PROTOTYPE) return undefined;
  try {
    const time = Reflect.apply(DATE_GET_TIME, value, []) as number;
    return Number.isFinite(time) ? time : undefined;
  } catch {
    // Objects spoofing Date.prototype have no native Date internal slot.
    return undefined;
  }
}

export const canonicalUuid = isCanonicalLowercaseUuid;
export const isExactDate = exactDateTime;
