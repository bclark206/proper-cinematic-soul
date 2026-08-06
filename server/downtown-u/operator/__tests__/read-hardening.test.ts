import { describe, expect, it, vi } from "vitest";
import { createOperatorAuthCryptography } from "../auth-crypto";
import { createReadCursorCodec, OperatorReadCursorError } from "../read-cursor";
import { parseOperatorReadQuery } from "../read-http";
import { PostgresOperatorReadStore, OperatorReadStoreError, type OperatorReadStoreInput } from "../postgres-read-store";
import { validateReadItems, type OperatorReadEndpoint, type ReadFilters } from "../read-types";

const secret = "AyQ7Gu1FZ6fR1esxrvIGvIN8Yl-Bhb12oZSjgqU2xLY";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const id = "223e4567-e89b-42d3-a456-426614174000";
const otherId = "323e4567-e89b-42d3-a456-426614174000";
const at = "2026-08-06T12:00:00.000Z";
const crypto = createOperatorAuthCryptography(secret);
const definitions: Array<{ endpoint: OperatorReadEndpoint; filters: ReadFilters; query: string }> = [
  { endpoint: "students", filters: { eligibilityStatus: "approved", studentId: id }, query: `eligibilityStatus=approved&studentId=${id}` },
  { endpoint: "purchases", filters: { status: "partially_refunded", studentId: id, purchaseId: otherId }, query: `status=partially_refunded&studentId=${id}&purchaseId=${otherId}` },
  { endpoint: "redemptions", filters: { status: "reversed", studentId: id, redemptionId: otherId }, query: `status=reversed&studentId=${id}&redemptionId=${otherId}` },
  { endpoint: "reconciliation", filters: { state: "resolved", category: "payment_follow_up", studentId: id, caseId: otherId }, query: `state=resolved&category=payment_follow_up&studentId=${id}&caseId=${otherId}` },
];

function signed(payload: string): string {
  return `${Buffer.from(payload).toString("base64url")}.${crypto.digestReadCursor(payload).toString("base64url")}`;
}

describe("operator dashboard read query matrix", () => {
  it.each(definitions)("accepts all canonical $endpoint filters and canonical client URL", ({ endpoint, filters, query }) => {
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}?limit=100&${query}`)).toEqual({ limit: 100, cursor: null, filters });
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}`)).toMatchObject({ limit: 25, cursor: null });
    expect(parseOperatorReadQuery(endpoint, `/api/downtown-u/operator/${endpoint}?limit=1`)).toMatchObject({ limit: 1 });
  });
  it.each(["0", "01", "101", "+1", "1%30", "", "-1"])("rejects noncanonical limit %s", (limit) => {
    expect(() => parseOperatorReadQuery("students", `/api/downtown-u/operator/students?limit=${limit}`)).toThrow();
  });
  it.each([
    "/api/downtown-u/operator/students?limit=1&limit=2",
    "/api/downtown-u/operator/students?unknown=1",
    `/api/downtown-u/operator/students?studentId=${id.toUpperCase()}`,
    "/api/downtown-u/operator/students?studentId[]=x",
    "/api/downtown-u/operator/purchases",
    "https://evil.test/api/downtown-u/operator/students",
    "/api/downtown-u/operator/students#fragment",
    "/api/downtown-u/operator/students?cursor=%61.a",
    `/api/downtown-u/operator/students?cursor=${"a".repeat(513)}.a`,
  ])("rejects ambiguous URL %s", (url) => expect(() => parseOperatorReadQuery("students", url)).toThrow());
  it("rejects controls and oversized URLs", () => {
    expect(() => parseOperatorReadQuery("students", "/api/downtown-u/operator/students\n")).toThrow();
    expect(() => parseOperatorReadQuery("students", `/api/downtown-u/operator/students?x=${"a".repeat(2048)}`)).toThrow();
  });
});

describe("operator dashboard cursor canonical envelope", () => {
  const filters = { eligibilityStatus: "approved", studentId: null } as const;
  it("emits fixed-order canonical JSON and remains session-bound without expiry", () => {
    const codec = createReadCursorCodec(crypto);
    const token = codec.encode("students", filters, sessionId, at, id);
    const payload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    expect(payload).toBe(`{"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}"}`);
    expect(codec.decode(token, "students", filters, sessionId)).toEqual({ createdAt: at, id });
  });
  it.each([
    "x",
    "***.***",
    `${"a".repeat(513)}.a`,
  ])("rejects malformed token %s", (token) => expect(() => createReadCursorCodec(crypto).decode(token, "students", filters, sessionId)).toThrow(OperatorReadCursorError));
  it("rejects tamper, noncanonical key order, extras, invalid timestamp/UUID and binding changes", () => {
    const codec = createReadCursorCodec(crypto);
    const valid = codec.encode("students", filters, sessionId, at, id);
    const payloads = [
      `{"endpoint":"students","v":1,"filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}"}`,
      `{"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}","extra":1}`,
      `{"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"not-time","id":"${id}"}`,
      `{"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id.toUpperCase()}"}`,
      `{"v":1,"v":1,"endpoint":"students","filters":{"eligibilityStatus":"approved","studentId":null},"sessionId":"${sessionId}","createdAt":"${at}","id":"${id}"}`,
    ];
    for (const payload of payloads) expect(() => codec.decode(signed(payload), "students", filters, sessionId)).toThrow(OperatorReadCursorError);
    expect(() => codec.decode(valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A"), "students", filters, sessionId)).toThrow();
    expect(() => codec.decode(valid, "students", { eligibilityStatus: null, studentId: null }, sessionId)).toThrow();
    expect(() => codec.decode(valid, "students", filters, otherId)).toThrow();
    expect(() => codec.decode(valid, "purchases", { status: null, studentId: null, purchaseId: null }, sessionId)).toThrow();
  });
});

function baseInput(endpoint: OperatorReadEndpoint, filters: ReadFilters): OperatorReadStoreInput {
  return { endpoint, sessionId, sessionDigest: Buffer.alloc(32, 7), correlationId: "operator-dashboard:test-0001", requestedLimit: 26, cursor: { createdAt: at, id }, filters };
}
function poolReturning(row: unknown, events: string[] = []) {
  const client = { query: vi.fn(async (text: string, values?: unknown[]) => {
    events.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: null, rows: [] };
    return { rowCount: 1, rows: [row], values };
  }), release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) }, client };
}

describe("postgres operator read store hardening", () => {
  it.each(definitions)("uses exact $endpoint SQL casts and ordered arguments in one transaction", async ({ endpoint, filters }) => {
    const events: string[] = [];
    const { pool, client } = poolReturning({ outcome: "authorized", items: [] }, events);
    const preflight = vi.fn(async () => { events.push("PREFLIGHT"); });
    const digest = Buffer.alloc(32, 7);
    const store = new PostgresOperatorReadStore(pool as never, preflight);
    await expect(store.read(baseInput(endpoint, filters))).resolves.toEqual({ outcome: "authorized", items: [] });
    const capability = client.query.mock.calls.find((call) => String(call[0]).startsWith("SELECT"));
    expect(capability?.[0]).toBe({
      students: "SELECT * FROM public.downtown_u_operator_read_students($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid)",
      purchases: "SELECT * FROM public.downtown_u_operator_read_purchases($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
      redemptions: "SELECT * FROM public.downtown_u_operator_read_redemptions($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::uuid,$10::uuid)",
      reconciliation: "SELECT * FROM public.downtown_u_operator_read_reconciliation($1::uuid,$2::smallint,$3::bytea,$4::text,$5::integer,$6::timestamptz,$7::uuid,$8::text,$9::text,$10::uuid,$11::uuid)",
    }[endpoint]);
    expect(capability?.[1]?.slice(0, 7)).toEqual([sessionId, 1, digest, "operator-dashboard:test-0001", 26, at, id]);
    expect(capability?.[1]?.slice(7)).toEqual(Object.values(filters));
    expect(events).toEqual(["BEGIN", "PREFLIGHT", expect.stringMatching(/^SELECT/), "COMMIT"]);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it.each([
    { requestedLimit: 0 }, { requestedLimit: 102 }, { requestedLimit: 1.5 }, { sessionId: id.toUpperCase() },
    { sessionDigest: Buffer.alloc(31) }, { correlationId: "short" }, { endpoint: "bogus" },
    { cursor: { createdAt: "bad", id } }, { cursor: { createdAt: at, id, extra: 1 } },
    { filters: { eligibilityStatus: undefined, studentId: null } },
    { filters: { status: null, studentId: null, purchaseId: null } },
  ])("returns invalid before connection for bad internal input %#", async (change) => {
    const { pool } = poolReturning({ outcome: "authorized", items: [] });
    const store = new PostgresOperatorReadStore(pool as never);
    await expect(store.read({ ...baseInput("students", { eligibilityStatus: null, studentId: null }), ...change } as never)).resolves.toEqual({ outcome: "invalid", items: null });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("rejects getters, symbols and throwing proxies without opening a transaction", async () => {
    const { pool } = poolReturning({ outcome: "authorized", items: [] });
    const store = new PostgresOperatorReadStore(pool as never);
    const getter = baseInput("students", { eligibilityStatus: null, studentId: null });
    Object.defineProperty(getter, "filters", { enumerable: true, get: vi.fn() });
    const symbol = { ...baseInput("students", { eligibilityStatus: null, studentId: null }), [Symbol("x")]: 1 };
    const proxy = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
    for (const candidate of [getter, symbol, proxy]) await expect(store.read(candidate as never)).resolves.toEqual({ outcome: "invalid", items: null });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it.each(["invalid", "denied"] as const)("accepts only exact one-row %s/null outcomes", async (outcome) => {
    const { pool } = poolReturning({ outcome, items: null });
    await expect(new PostgresOperatorReadStore(pool as never, async () => undefined).read(baseInput("students", { eligibilityStatus: null, studentId: null }))).resolves.toEqual({ outcome, items: null });
  });
  it("rolls back and wraps preflight/query/result failures", async () => {
    const events: string[] = [];
    const { pool } = poolReturning({ outcome: "authorized", items: null }, events);
    await expect(new PostgresOperatorReadStore(pool as never, async () => { throw new TypeError("preflight"); }).read(baseInput("students", { eligibilityStatus: null, studentId: null }))).rejects.toBeInstanceOf(OperatorReadStoreError);
    expect(events).toEqual(["BEGIN", "ROLLBACK"]);
  });
  it.each([
    { outcome: "authorized", items: null }, { outcome: "denied", items: [] }, { outcome: "authorized", items: [], extra: 1 },
  ])("rejects malformed capability row %#", async (row) => {
    const { pool } = poolReturning(row);
    await expect(new PostgresOperatorReadStore(pool as never, async () => undefined).read(baseInput("students", { eligibilityStatus: null, studentId: null }))).rejects.toBeInstanceOf(OperatorReadStoreError);
  });
});

describe("redacted read item validation", () => {
  const student = { id, eligibilityStatus: "approved", maskedEmail: "a***@e***.edu", approvedAt: at, createdAt: at, updatedAt: at };
  it("copies and freezes authorized arrays/items", () => {
    const source = [student]; const result = validateReadItems("students", source);
    expect(result).toEqual(source); expect(result).not.toBe(source); expect(result[0]).not.toBe(student);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
  });
  it.each([
    { ...student, normalizedEmail: "raw@example.test" },
    { ...student, maskedEmail: undefined },
    { ...student, maskedEmail: "bad" },
    { ...student, approvedAt: undefined },
    { ...student, eligibilityStatus: "pending" },
  ])("rejects student leakage/masking/lifecycle inconsistency %#", (candidate) => expect(() => validateReadItems("students", [candidate])).toThrow());
  it("rejects symbols, accessors, buffers and proxy traps without returning data", () => {
    const accessor = { ...student }; Object.defineProperty(accessor, "id", { enumerable: true, get: vi.fn() });
    const symbol = { ...student, [Symbol("secret")]: "x" };
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
    for (const candidate of [accessor, symbol, Buffer.from("x"), proxy]) expect(() => validateReadItems("students", [candidate])).toThrow();
  });
  it("enforces purchase, redemption and reconciliation state chronology", () => {
    expect(() => validateReadItems("purchases", [{ id, studentId: otherId, planId: "flex-5", creditsGranted: 5, priceCents: 6000, currency: "USD", status: "paid", refundedCredits: 1, paidAt: at, createdAt: at, updatedAt: at }])).toThrow();
    expect(() => validateReadItems("redemptions", [{ id, studentId: otherId, mealName: "Meal", credits: 1, status: "redeemed", reservedAt: at, expiresAt: at, createdAt: at, updatedAt: at }])).toThrow();
    expect(() => validateReadItems("reconciliation", [{ id, studentId: otherId, category: "payment_follow_up", state: "resolved", openedAt: at }])).toThrow();
  });
});
