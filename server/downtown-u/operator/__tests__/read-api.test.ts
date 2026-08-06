import { describe, expect, it, vi } from "vitest";
import { OperatorAuthBoundaryError } from "../auth-http";
import {
  createReadCursorCodec,
  OperatorReadCursorError,
} from "../read-cursor";
import { parseOperatorReadQuery } from "../read-http";
import {
  OperatorReadStoreError,
  PostgresOperatorReadStore,
  type OperatorReadStoreInput,
} from "../postgres-read-store";
import {
  validateReadItems,
  type OperatorReadEndpoint,
  type ReadFilters,
} from "../read-types";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const id = "223e4567-e89b-42d3-a456-426614174000";
const otherId = "323e4567-e89b-42d3-a456-426614174000";
const at = "2026-08-06T12:00:00.000Z";
const before = "2026-08-06T11:59:00.000Z";
const later = "2026-08-06T12:01:00.000Z";
const digest = Buffer.alloc(32, 7);

const definitions: ReadonlyArray<{
  endpoint: OperatorReadEndpoint;
  filters: ReadFilters;
  query: string;
}> = [
  {
    endpoint: "students",
    filters: { eligibilityStatus: "approved", studentId: id },
    query: `eligibilityStatus=approved&studentId=${id}`,
  },
  {
    endpoint: "purchases",
    filters: { status: "partially_refunded", studentId: id, purchaseId: otherId },
    query: `status=partially_refunded&studentId=${id}&purchaseId=${otherId}`,
  },
  {
    endpoint: "redemptions",
    filters: { status: "reversed", studentId: id, redemptionId: otherId },
    query: `status=reversed&studentId=${id}&redemptionId=${otherId}`,
  },
  {
    endpoint: "reconciliation",
    filters: {
      state: "resolved",
      category: "payment_follow_up",
      studentId: id,
      caseId: otherId,
    },
    query: `state=resolved&category=payment_follow_up&studentId=${id}&caseId=${otherId}`,
  },
];

function expectBoundaryFailure(endpoint: OperatorReadEndpoint, raw: unknown): void {
  expect(() => parseOperatorReadQuery(endpoint, raw)).toThrow(OperatorAuthBoundaryError);
}

describe("operator dashboard query boundary", () => {
  it.each(definitions)("returns canonical fixed-order $endpoint filters", ({ endpoint, filters, query }) => {
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}`)).toEqual({
      limit: 25,
      cursor: null,
      filters: Object.fromEntries(Object.keys(filters).map((key) => [key, null])),
    });
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}?limit=1`)).toMatchObject({ limit: 1 });
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}?limit=100&${query}`)).toEqual({
      limit: 100,
      cursor: null,
      filters,
    });
    expect(Object.keys(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}`).filters))
      .toEqual(Object.keys(filters));
  });

  it.each(["0", "01", "101", "+1", " 1", "1 ", "", "-1", "1.0"])(
    "rejects a noncanonical limit %j",
    (limit) => expectBoundaryFailure("students", `/api/downtown-u/operator/students?limit=${limit}`),
  );

  it.each([
    "/api/downtown-u/operator/students?limit=1&limit=2",
    "/api/downtown-u/operator/students?unknown=1",
    `/api/downtown-u/operator/students?studentId=${id.toUpperCase()}`,
    "/api/downtown-u/operator/students?EligibilityStatus=approved",
    "/api/downtown-u/operator/students?studentId[]=x",
    "/api/downtown-u/operator/purchases",
    "https://operator.invalid/api/downtown-u/operator/students",
    "https://evil.test/api/downtown-u/operator/students",
    "/api/downtown-u/operator/students#fragment",
    "/api/downtown-u/operator/students?limit=%31",
    "/api/downtown-u/operator/students?cursor=%61.a",
    "/api/downtown-u/operator/students?cursor=",
    "/api/downtown-u/operator/students?cursor=a",
    "/api/downtown-u/operator/students?cursor=a.",
    `/api/downtown-u/operator/students?cursor=${"a".repeat(510)}.aa`,
  ])("rejects ambiguous URL %j", (url) => expectBoundaryFailure("students", url));

  it("rejects nonstrings, controls, and URLs over 2048 UTF-8 bytes", () => {
    for (const raw of [null, new URL("https://operator.invalid/api/downtown-u/operator/students"),
      "/api/downtown-u/operator/students\n", "/api/downtown-u/operator/students?x=\u0000"]) {
      expectBoundaryFailure("students", raw);
    }
    const prefix = "/api/downtown-u/operator/students?cursor=";
    expectBoundaryFailure("students", prefix + "é".repeat(1_100));
  });
});

function cursorCrypto() {
  return {
    digestReadCursor: vi.fn((payload: string) =>
      Buffer.from(payload).subarray(0, 0).length === 0
        ? Buffer.from("4d8f1b57d5f3475ee08a76d8eaea6f9e3a61b7ef180598c978d633cd65759225", "hex")
        : Buffer.alloc(32)),
  };
}

function signed(payload: string): string {
  const mac = cursorCrypto().digestReadCursor(payload);
  return `${Buffer.from(payload).toString("base64url")}.${mac.toString("base64url")}`;
}

function expectCursorFailure(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected cursor failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorReadCursorError);
  }
}

describe("operator dashboard cursor codec", () => {
  it.each(definitions)("round trips canonical, fixed-order, session-bound $endpoint payloads", ({ endpoint, filters }) => {
    const crypto = cursorCrypto();
    const codec = createReadCursorCodec(crypto);
    const token = codec.encode(endpoint, filters, sessionId, at, id);
    const payload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    expect(payload).toBe(JSON.stringify({ v: 1, endpoint, filters, sessionId, createdAt: at, id }));
    expect(payload).not.toContain("bearer");
    expect(codec.decode(token, endpoint, filters, sessionId)).toEqual({ createdAt: at, id });
  });

  it("rejects MAC/payload tamper and endpoint, filter, or session rebinding", () => {
    const codec = createReadCursorCodec(cursorCrypto());
    const filters = { eligibilityStatus: "approved", studentId: null } as const;
    const token = codec.encode("students", filters, sessionId, at, id);
    const [payload, mac] = token.split(".");
    for (const candidate of [
      `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`,
      `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`,
    ]) expectCursorFailure(() => codec.decode(candidate, "students", filters, sessionId));
    expectCursorFailure(() => codec.decode(token, "students", { eligibilityStatus: null, studentId: null }, sessionId));
    expectCursorFailure(() => codec.decode(token, "students", filters, otherId));
    expectCursorFailure(() => codec.decode(token, "purchases", { status: null, studentId: null, purchaseId: null }, sessionId));
  });

  it.each(["", "x", ".", "a.", ".a", "a.b.c", "***.***", "YR.a", `${"a".repeat(513)}.a`])(
    "rejects malformed/noncanonical token %j with only OperatorReadCursorError",
    (token) => expectCursorFailure(() => createReadCursorCodec(cursorCrypto()).decode(
      token,
      "students",
      { eligibilityStatus: null, studentId: null },
      sessionId,
    )),
  );

  it("rejects signed noncanonical or invalid JSON envelopes", () => {
    const filters = { eligibilityStatus: "approved", studentId: null } as const;
    const canonical = { v: 1, endpoint: "students", filters, sessionId, createdAt: at, id };
    const payloads = [
      JSON.stringify({ endpoint: "students", v: 1, filters, sessionId, createdAt: at, id }),
      JSON.stringify({ ...canonical, extra: 1 }),
      JSON.stringify({ v: 2, endpoint: "students", filters, sessionId, createdAt: at, id }),
      JSON.stringify({ v: 1, endpoint: "students", sessionId, createdAt: at, id }),
      JSON.stringify({ ...canonical, createdAt: "2026-02-30T00:00:00.000Z" }),
      JSON.stringify({ ...canonical, id: id.toUpperCase() }),
      `{"v":1,"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}"}`,
      `{"v":1,"endpoint":"students","filters":{"studentId":null,"eligibilityStatus":"approved"},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}"}`,
    ];
    for (const payload of payloads) expectCursorFailure(() => createReadCursorCodec(cursorCrypto()).decode(
      signed(payload), "students", filters, sessionId,
    ));
  });

  it.each([new Error("provider unavailable"), new TypeError("provider contract failure")])(
    "preserves an internal digest failure during decode (%s)",
    (failure) => {
      const filters = { eligibilityStatus: null, studentId: null } as const;
      const token = createReadCursorCodec(cursorCrypto()).encode("students", filters, sessionId, at, id);
      const throwing = createReadCursorCodec({ digestReadCursor() { throw failure; } });
      try {
        throwing.decode(token, "students", filters, sessionId);
        throw new Error("expected digest failure");
      } catch (error) {
        expect(error).toBe(failure);
        expect(error).not.toBeInstanceOf(OperatorReadCursorError);
      }
    },
  );

  it("keeps malformed digest results internal while retaining caller-input cursor errors", () => {
    const failure = new Error("provider unavailable");
    const throwing = createReadCursorCodec({ digestReadCursor() { throw failure; } });
    const short = createReadCursorCodec({ digestReadCursor() { return Buffer.alloc(31); } });
    const filters = { eligibilityStatus: null, studentId: null } as const;
    expect(() => throwing.encode("students", filters, sessionId, at, id)).toThrow(failure);
    expect(() => short.encode("students", filters, sessionId, at, id)).toThrow(Error);
    expect(() => short.encode("students", filters, sessionId, at, id)).not.toThrow(OperatorReadCursorError);
    const token = createReadCursorCodec(cursorCrypto()).encode("students", filters, sessionId, at, id);
    expect(() => short.decode(token, "students", filters, sessionId)).toThrow(Error);
    expect(() => short.decode(token, "students", filters, sessionId)).not.toThrow(OperatorReadCursorError);
    expectCursorFailure(() => createReadCursorCodec(cursorCrypto()).encode(
      "students", new Proxy(filters, { ownKeys() { throw new TypeError("trap"); } }), sessionId, at, id,
    ));
  });
});

const validItems: Record<OperatorReadEndpoint, Record<string, unknown>> = {
  students: {
    id,
    eligibilityStatus: "approved",
    maskedEmail: "a***@e***.edu",
    approvedAt: at,
    createdAt: at,
    updatedAt: later,
  },
  purchases: {
    id,
    studentId: otherId,
    planId: "flex-5",
    creditsGranted: 5,
    priceCents: 6000,
    currency: "USD",
    status: "paid",
    refundedCredits: 0,
    paidAt: before,
    createdAt: at,
    updatedAt: later,
  },
  redemptions: {
    id,
    studentId: otherId,
    mealName: "Lunch",
    credits: 1,
    status: "reserved",
    reservedAt: at,
    createdAt: at,
    updatedAt: later,
  },
  reconciliation: {
    id,
    studentId: otherId,
    category: "payment_follow_up",
    state: "needs_review",
    openedAt: at,
  },
};

const validItemEntries = Object.entries(validItems) as Array<
  [OperatorReadEndpoint, Record<string, unknown>]
>;

describe("redacted read-item validators", () => {
  it.each(validItemEntries)("copies and freezes valid %s items", (endpoint, item) => {
    const source = [item];
    const result = validateReadItems(endpoint, source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result[0]).not.toBe(item);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("rejects oversized, sparse, accessor-bearing, and decorated arrays without invoking getters", () => {
    expect(() => validateReadItems("students", Array.from({ length: 102 }, () => validItems.students))).toThrow();
    expect(() => validateReadItems("students", new Array(1))).toThrow();
    const getter = vi.fn(() => validItems.students);
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get: getter });
    Object.defineProperty(accessor, "length", { value: 1 });
    expect(() => validateReadItems("students", accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const decorated = [validItems.students] as unknown[] & { extra?: number };
    decorated.extra = 1;
    expect(() => validateReadItems("students", decorated)).toThrow();
  });

  it("rejects item unknown/missing/accessor/symbol/Buffer/proxy values without invoking getters", () => {
    const unknown = { ...validItems.students, rawEmail: "raw@example.test" };
    const missing = { ...validItems.students };
    delete missing.id;
    const accessor = { ...validItems.students };
    const getter = vi.fn(() => id);
    Object.defineProperty(accessor, "id", { enumerable: true, get: getter });
    const symbol = { ...validItems.students, [Symbol("secret")]: "x" };
    const proxy = new Proxy({}, { getPrototypeOf() { throw new TypeError("trap"); } });
    for (const item of [unknown, missing, accessor, symbol, Buffer.from("x"), proxy]) {
      expect(() => validateReadItems("students", [item])).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { ...validItems.students, maskedEmail: "bad" },
    { ...validItems.students, maskedEmail: "a***@e***.edu\n" },
    { ...validItems.students, maskedEmail: "a".repeat(255) },
    { ...validItems.students, maskedPhone: "+**4567" },
    { ...validItems.students, maskedPhone: "+************2345" },
    { ...validItems.students, eligibilityStatus: "pending" },
    { ...validItems.students, eligibilityStatus: "rejected", approvedAt: undefined, rejectedAt: undefined },
    { ...validItems.students, eligibilityStatus: "suspended", suspendedAt: undefined },
    { ...validItems.students, approvedAt: "2026-02-30T00:00:00.000Z" },
  ])("rejects malformed student %#", (item) => expect(() => validateReadItems("students", [item])).toThrow());

  it("accepts migration-valid student masks and one-direction status lifecycles", () => {
    const base = { id, maskedPhone: "+***4567", createdAt: at, updatedAt: later };
    const migrationRows = [
      { ...base, eligibilityStatus: "pending", eligibilityReviewedAt: later },
      { ...base, eligibilityStatus: "approved" },
      { ...base, eligibilityStatus: "approved", approvedAt: later },
      { ...base, eligibilityStatus: "rejected" },
      { ...base, eligibilityStatus: "rejected", rejectedAt: later },
      { ...base, eligibilityStatus: "suspended" },
      { ...base, eligibilityStatus: "suspended", suspendedAt: later },
      { ...base, eligibilityStatus: "suspended", approvedAt: later },
      { ...base, maskedPhone: "+***********2345", eligibilityStatus: "approved" },
    ];
    for (const row of migrationRows) {
      expect(() => validateReadItems("students", [row])).not.toThrow();
    }
  });

  it.each([
    ["pending eligibilityReviewedAt", { eligibilityStatus: "pending", eligibilityReviewedAt: before }],
    ["approved approvedAt", { eligibilityStatus: "approved", approvedAt: before }],
    ["updatedAt", { eligibilityStatus: "pending", updatedAt: before }],
    ["deletedAt", { eligibilityStatus: "pending", deletedAt: before }],
  ])("accepts schema-valid student %s before createdAt", (_label, timestamps) => {
    const base = { id, maskedPhone: "+*******4567", createdAt: at, updatedAt: later };
    expect(() => validateReadItems("students", [{ ...base, ...timestamps }])).not.toThrow();
  });

  it.each([
    { eligibilityStatus: "pending", approvedAt: later },
    { eligibilityStatus: "pending", rejectedAt: later },
    { eligibilityStatus: "pending", suspendedAt: later },
    { eligibilityStatus: "approved", rejectedAt: later },
    { eligibilityStatus: "approved", suspendedAt: later },
    { eligibilityStatus: "rejected", approvedAt: later },
    { eligibilityStatus: "rejected", suspendedAt: later },
    { eligibilityStatus: "suspended", rejectedAt: later },
  ])("rejects migration-incompatible student lifecycle %#", (lifecycle) => {
    const base = { id, maskedPhone: "+*******4567", createdAt: at, updatedAt: later };
    expect(() => validateReadItems("students", [{ ...base, ...lifecycle }])).toThrow();
  });

  it.each([
    { status: "paid", refundedCredits: 1 },
    { status: "paid", refundedAt: later },
    { status: "partially_refunded", refundedCredits: 0, refundedAt: later },
    { status: "partially_refunded", refundedCredits: 5, refundedAt: later },
    { status: "refunded", refundedCredits: 4, refundedAt: later },
    { creditsGranted: 4 },
    { priceCents: 0 },
    { priceCents: 6001 },
    { creditsGranted: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid purchase economics/lifecycle %#", (change) => {
    expect(() => validateReadItems("purchases", [{ ...validItems.purchases, ...change }])).toThrow();
  });

  it("accepts partial and full refund chronology", () => {
    expect(() => validateReadItems("purchases", [{ ...validItems.purchases, status: "partially_refunded", refundedCredits: 2, refundedAt: later }])).not.toThrow();
    expect(() => validateReadItems("purchases", [{ ...validItems.purchases, status: "refunded", refundedCredits: 5, refundedAt: later }])).not.toThrow();
  });

  it.each([
    ["flex-5", 5, 6000],
    ["scholar-10", 10, 11000],
    ["resident-20", 20, 21000],
    ["semester-40", 40, 40000],
  ] as const)("accepts only canonical %s credits and price", (planId, creditsGranted, priceCents) => {
    const purchase = { ...validItems.purchases, planId, creditsGranted, priceCents };
    expect(() => validateReadItems("purchases", [purchase])).not.toThrow();
    expect(() => validateReadItems("purchases", [{ ...purchase, priceCents: priceCents + 1 }])).toThrow();
  });

  it("accepts provider-authoritative paidAt before database creation", () => {
    expect(() => validateReadItems("purchases", [validItems.purchases])).not.toThrow();
  });

  it("enforces redemption state timestamps while cancelled remains permissive", () => {
    const base = validItems.redemptions;
    expect(() => validateReadItems("redemptions", [{ ...base, status: "reserved", redeemedAt: later }])).toThrow();
    expect(() => validateReadItems("redemptions", [{ ...base, status: "redeemed" }])).toThrow();
    expect(() => validateReadItems("redemptions", [{ ...base, status: "redeemed", redeemedAt: later }])).not.toThrow();
    expect(() => validateReadItems("redemptions", [{ ...base, status: "reversed" }])).toThrow();
    expect(() => validateReadItems("redemptions", [{ ...base, status: "reversed", reversedAt: later }])).not.toThrow();
    expect(() => validateReadItems("redemptions", [{ ...base, status: "cancelled", redeemedAt: later }])).not.toThrow();
  });

  it("accepts omitted redemption expiry and validates it only when present", () => {
    expect(() => validateReadItems("redemptions", [validItems.redemptions])).not.toThrow();
    expect(() => validateReadItems("redemptions", [{ ...validItems.redemptions, expiresAt: later }])).not.toThrow();
    expect(() => validateReadItems("redemptions", [{ ...validItems.redemptions, expiresAt: before }])).toThrow();
  });

  it("bounds redemption display and numeric fields", () => {
    for (const change of [{ mealName: "" }, { mealName: "x".repeat(161) }, { mealName: "meal\u0000" }, { credits: 0 }, { credits: Number.MAX_SAFE_INTEGER }]) {
      expect(() => validateReadItems("redemptions", [{ ...validItems.redemptions, ...change }])).toThrow();
    }
  });

  it("enforces reconciliation state timestamps and exact enums", () => {
    const base = validItems.reconciliation;
    expect(() => validateReadItems("reconciliation", [{ ...base, resolvedAt: later }])).toThrow();
    expect(() => validateReadItems("reconciliation", [{ ...base, state: "resolved" }])).toThrow();
    expect(() => validateReadItems("reconciliation", [{ ...base, state: "resolved", resolvedAt: later }])).not.toThrow();
    expect(() => validateReadItems("reconciliation", [{ ...base, category: "other" }])).toThrow();
  });
});

function baseInput(endpoint: OperatorReadEndpoint, filters: ReadFilters): OperatorReadStoreInput {
  return {
    endpoint,
    sessionId,
    sessionDigest: digest,
    correlationId: "operator-dashboard:test-0001",
    requestedLimit: 26,
    cursor: { createdAt: at, id },
    filters,
  };
}

function mockPool(row: unknown, options: { throwCapability?: boolean } = {}) {
  const events: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      events.push(text);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: null, rows: [] };
      if (options.throwCapability) throw new Error("query failed");
      return { rowCount: 1, rows: [row], values };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, client, events };
}

const exactSql: Record<OperatorReadEndpoint, string> = {
  students: "SELECT * FROM public.downtown_u_operator_read_students($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid)",
  purchases: "SELECT * FROM public.downtown_u_operator_read_purchases($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
  redemptions: "SELECT * FROM public.downtown_u_operator_read_redemptions($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
  reconciliation: "SELECT * FROM public.downtown_u_operator_read_reconciliation($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::text,$10::uuid,$11::uuid)",
};

describe("Postgres operator dashboard read adapter", () => {
  it.each(definitions)("uses exact $endpoint SQL, casts, arguments, client and transaction order", async ({ endpoint, filters }) => {
    const { pool, client, events } = mockPool({ outcome: "authorized", items: [] });
    const preflight = vi.fn(async (queryable) => {
      expect(queryable).toBe(client);
      events.push("PREFLIGHT");
    });
    const store = new PostgresOperatorReadStore(pool as never, preflight);
    await expect(store.read(baseInput(endpoint, filters))).resolves.toEqual({ outcome: "authorized", items: [] });
    const capability = client.query.mock.calls.find(([text]) => String(text).startsWith("SELECT"));
    expect(capability?.[0]).toBe(exactSql[endpoint]);
    expect(capability?.[1]).toEqual([sessionId, 1, digest, "operator-dashboard:test-0001", 26, at, id, ...Object.values(filters)]);
    expect(capability?.[1]?.[2]).not.toBe(digest);
    expect(events).toEqual(["BEGIN", "PREFLIGHT", exactSql[endpoint], "COMMIT"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    { requestedLimit: 0 }, { requestedLimit: 102 }, { requestedLimit: 1.5 },
    { sessionId: id.toUpperCase() }, { sessionDigest: Buffer.alloc(31) },
    { correlationId: "short" }, { endpoint: "bogus" },
    { cursor: { createdAt: "bad", id } }, { cursor: { createdAt: at, id, extra: 1 } },
    { filters: { eligibilityStatus: undefined, studentId: null } },
    { filters: { status: null, studentId: null, purchaseId: null } },
  ])("returns exact invalid/null before touching pool for bad input %#", async (change) => {
    const { pool } = mockPool({ outcome: "authorized", items: [] });
    const input = { ...baseInput("students", { eligibilityStatus: null, studentId: null }), ...change };
    await expect(new PostgresOperatorReadStore(pool as never).read(input as never))
      .resolves.toEqual({ outcome: "invalid", items: null });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects accessors, symbols, and proxy traps before pool without invoking getters", async () => {
    const { pool } = mockPool({ outcome: "authorized", items: [] });
    const store = new PostgresOperatorReadStore(pool as never);
    const accessor = baseInput("students", { eligibilityStatus: null, studentId: null });
    const getter = vi.fn(() => accessor.filters);
    Object.defineProperty(accessor, "filters", { enumerable: true, get: getter });
    const symbol = { ...baseInput("students", { eligibilityStatus: null, studentId: null }), [Symbol("x")]: 1 };
    const proxy = new Proxy({}, { ownKeys() { throw new TypeError("trap"); } });
    for (const candidate of [accessor, symbol, proxy]) {
      await expect(store.read(candidate as never)).resolves.toEqual({ outcome: "invalid", items: null });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("copies the digest before asynchronous preflight", async () => {
    const { pool, client } = mockPool({ outcome: "authorized", items: [] });
    const input = baseInput("students", { eligibilityStatus: null, studentId: null });
    const store = new PostgresOperatorReadStore(pool as never, async () => { input.sessionDigest.fill(9); });
    await store.read(input);
    const capability = client.query.mock.calls.find(([text]) => String(text).startsWith("SELECT"));
    expect(capability?.[1]?.[2]).toEqual(Buffer.alloc(32, 7));
  });

  it.each(["invalid", "denied"] as const)("returns exact %s/null and commits", async (outcome) => {
    const { pool, events } = mockPool({ outcome, items: null });
    await expect(new PostgresOperatorReadStore(pool as never, async () => undefined)
      .read(baseInput("students", { eligibilityStatus: null, studentId: null })))
      .resolves.toEqual({ outcome, items: null });
    expect(events.at(-1)).toBe("COMMIT");
  });

  it.each([
    { outcome: "authorized", items: null },
    { outcome: "denied", items: [] },
    { outcome: "authorized", items: [], extra: 1 },
    { outcome: "other", items: [] },
  ])("rolls back and wraps malformed row %#", async (row) => {
    const { pool, client, events } = mockPool(row);
    await expect(new PostgresOperatorReadStore(pool as never, async () => undefined)
      .read(baseInput("students", { eligibilityStatus: null, studentId: null })))
      .rejects.toBeInstanceOf(OperatorReadStoreError);
    expect(events.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back, releases, and wraps query failures", async () => {
    const { pool, client, events } = mockPool(null, { throwCapability: true });
    await expect(new PostgresOperatorReadStore(pool as never, async () => undefined)
      .read(baseInput("students", { eligibilityStatus: null, studentId: null })))
      .rejects.toBeInstanceOf(OperatorReadStoreError);
    expect(events).toEqual(["BEGIN", exactSql.students, "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns immutable copied authorized data and rejects malformed items", async () => {
    const source = [validItems.students];
    const success = mockPool({ outcome: "authorized", items: source });
    const result = await new PostgresOperatorReadStore(success.pool as never, async () => undefined)
      .read(baseInput("students", { eligibilityStatus: null, studentId: null }));
    expect(result.outcome).toBe("authorized");
    if (result.outcome === "authorized") {
      expect(result.items).not.toBe(source);
      expect(result.items[0]).not.toBe(source[0]);
      expect(Object.isFrozen(result.items)).toBe(true);
    }
    const failure = mockPool({ outcome: "authorized", items: [{ ...validItems.students, secret: "x" }] });
    await expect(new PostgresOperatorReadStore(failure.pool as never, async () => undefined)
      .read(baseInput("students", { eligibilityStatus: null, studentId: null })))
      .rejects.toBeInstanceOf(OperatorReadStoreError);
    expect(failure.events.at(-1)).toBe("ROLLBACK");
  });
});
