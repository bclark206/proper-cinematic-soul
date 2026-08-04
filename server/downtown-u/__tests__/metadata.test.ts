import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalizeLedgerMetadata,
  DowntownUCredits,
  IdempotencyConflictError,
  InvalidCreditOperationError,
  MAX_LEDGER_METADATA_BYTES,
  type LedgerMetadata,
} from "../credits";
import { InMemoryCreditStore } from "../testing/in-memory-credit-store";

const studentId = "10000000-0000-4000-8000-000000000099";

function purchaseInput(metadata: LedgerMetadata, suffix = "metadata") {
  return {
    studentId,
    planId: "flex-5" as const,
    squarePaymentId: `payment-${suffix}`,
    squareOrderId: `order-${suffix}`,
    sourceEventId: `event-${suffix}`,
    actorId: "square-webhook",
    metadata,
  };
}

describe("Downtown U ledger metadata", () => {
  let store: InMemoryCreditStore;
  let credits: DowntownUCredits;

  beforeEach(() => {
    store = new InMemoryCreditStore();
    store.addStudent(studentId);
    credits = new DowntownUCredits(store);
  });

  it("canonicalizes nested object keys so key order is idempotently equivalent", async () => {
    const first = await credits.grantPaidPurchase(purchaseInput({ z: 1, nested: { y: true, a: "first" }, a: 2 }));
    const retry = await credits.grantPaidPurchase(purchaseInput({ a: 2, nested: { a: "first", y: true }, z: 1 }));

    expect(retry).toEqual(first);
    const persisted = store.ledgerFor(studentId)[0].metadata;
    expect(Object.keys(persisted)).toEqual(["a", "nested", "z"]);
    expect(Object.keys(persisted.nested as Record<string, unknown>)).toEqual(["a", "y"]);
  });

  it("preserves root and nested special JSON keys without prototype mutation", () => {
    const input = JSON.parse('{"__proto__":{"polluted":"root"},"constructor":"constructor-value","nested":{"__proto__":"nested-value","constructor":"nested-constructor","prototype":"nested-prototype"},"prototype":"prototype-value"}') as LedgerMetadata;

    const canonical = canonicalizeLedgerMetadata(input);
    const nested = canonical.nested as LedgerMetadata;

    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(canonical, "__proto__")).toBe(true);
    expect(Object.hasOwn(canonical, "constructor")).toBe(true);
    expect(Object.hasOwn(canonical, "prototype")).toBe(true);
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);
    expect(canonical.__proto__).toEqual({ polluted: "root" });
    expect(nested.__proto__).toBe("nested-value");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(canonicalJson(canonical)).toContain('"__proto__":{"polluted":"root"}');
    expect(canonicalJson(canonical)).not.toBe(canonicalJson(canonicalizeLedgerMetadata(
      JSON.parse('{"__proto__":{"polluted":"changed"},"constructor":"constructor-value","nested":{"__proto__":"nested-value","constructor":"nested-constructor","prototype":"nested-prototype"},"prototype":"prototype-value"}'),
    )));
  });

  it("treats changed __proto__ metadata as an idempotency conflict", async () => {
    const first = JSON.parse('{"__proto__":{"value":"first"},"nested":{"__proto__":"same"}}') as LedgerMetadata;
    const changed = JSON.parse('{"__proto__":{"value":"changed"},"nested":{"__proto__":"same"}}') as LedgerMetadata;

    await credits.grantPaidPurchase(purchaseInput(first, "proto-conflict"));
    await expect(credits.grantPaidPurchase(purchaseInput(changed, "proto-conflict")))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["symbol", { value: Symbol("not-json") }],
    ["BigInt", { value: 1n }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["Date", { value: new Date("2026-08-04T00:00:00Z") }],
    ["class instance", { value: new (class Metadata {})() }],
  ])("rejects non-JSON metadata containing %s", (_label, metadata) => {
    expect(() => credits.grantPaidPurchase(purchaseInput(metadata as unknown as LedgerMetadata)))
      .toThrow(InvalidCreditOperationError);
    expect(store.ledgerFor(studentId)).toHaveLength(0);
  });

  it("rejects cyclic metadata", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => credits.grantPaidPurchase(purchaseInput(cyclic as LedgerMetadata)))
      .toThrow(InvalidCreditOperationError);
  });

  it.each([
    ["the maximum uint32 key", "4294967295"],
    ["an index equal to length", "1"],
    ["a non-index property", "extra"],
  ])("rejects arrays with %s instead of silently canonicalizing distinct inputs together", (_label, key) => {
    const target = ["kept"] as unknown[] & Record<string, unknown>;
    const array = key === "1"
      ? new Proxy(target, {
          ownKeys: (value) => [...Reflect.ownKeys(value), key],
          getOwnPropertyDescriptor: (value, property) => property === key
            ? { value: `discarded-${key}`, enumerable: true, configurable: true, writable: true }
            : Reflect.getOwnPropertyDescriptor(value, property),
        })
      : target;
    if (array === target) {
      Object.defineProperty(array, key, { value: `discarded-${key}`, enumerable: true, configurable: true });
    }

    expect(() => canonicalizeLedgerMetadata({ array })).toThrow(InvalidCreditOperationError);
    expect(store.ledgerFor(studentId)).toHaveLength(0);
  });

  it("continues to reject array holes, accessors, and non-enumerable elements", () => {
    const hole = new Array(1);
    const accessor = ["value"];
    Object.defineProperty(accessor, "0", { get: () => "value", enumerable: true, configurable: true });
    const nonEnumerable = ["value"];
    Object.defineProperty(nonEnumerable, "0", { value: "value", enumerable: false, configurable: true });

    for (const array of [hole, accessor, nonEnumerable]) {
      expect(() => canonicalizeLedgerMetadata({ array })).toThrow(InvalidCreditOperationError);
    }
  });

  it("rejects metadata over the UTF-8 serialized size limit", () => {
    const metadata = { text: "😀".repeat(MAX_LEDGER_METADATA_BYTES) };

    expect(() => credits.grantPaidPurchase(purchaseInput(metadata)))
      .toThrow(InvalidCreditOperationError);
  });

  it("persists and reads back the same canonical metadata without retaining caller references", async () => {
    const metadata = { tags: ["meal", null, 4], details: { z: false, a: "value" } };
    const expected = { details: { a: "value", z: false }, tags: ["meal", null, 4] };
    await credits.grantPaidPurchase(purchaseInput(metadata));
    metadata.details.a = "mutated";

    expect(store.ledgerFor(studentId)[0].metadata).toEqual(expected);
    expect(store.ledgerFor(studentId)[0].metadata).not.toBe(metadata);
  });
});
