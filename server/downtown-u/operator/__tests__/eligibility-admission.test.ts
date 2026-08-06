import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOperatorEligibilityAdmission } from "../eligibility-admission";

const secret = Buffer.alloc(32, 7).toString("base64url");
const token = "rest-token";
const env = Object.freeze({ VERCEL: "1", UPSTASH_REDIS_REST_URL: "https://safe-name.upstash.io", UPSTASH_REDIS_REST_TOKEN: token, DOWNTOWN_U_OPERATOR_AUTH_SECRET: secret }) as NodeJS.ProcessEnv;
const input = Object.freeze({ sessionId: "123e4567-e89b-42d3-a456-426614174000", targetId: "223e4567-e89b-42d3-a456-426614174000", origin: "https://operator.example.test", secFetchSite: "same-origin" as const, correlationId: "operator-mutation:323e4567-e89b-42d3-a456-426614174000" });
const response = (body: string | Buffer, status = 200) => new Response(body, { status });

describe("production eligibility admission", () => {
  it.each([
    { VERCEL: "true" }, { UPSTASH_REDIS_REST_URL: "http://safe-name.upstash.io" },
    { UPSTASH_REDIS_REST_URL: "https://evil.test" }, { UPSTASH_REDIS_REST_URL: "https://safe-name.upstash.io/path" },
    { UPSTASH_REDIS_REST_TOKEN: "" }, { UPSTASH_REDIS_REST_TOKEN: "x\nsecret" },
    { UPSTASH_REDIS_REST_TOKEN: "x".repeat(4097) }, { DOWNTOWN_U_OPERATOR_AUTH_SECRET: "bad" },
  ])("rejects non-exact configuration %#", (change) => {
    expect(() => createOperatorEligibilityAdmission({ ...env, ...change } as NodeJS.ProcessEnv, vi.fn())).toThrow(/unavailable/);
  });

  it("posts exact Upstash eval shape with domain-separated pseudonyms and no raw sensitive values", async () => {
    const fetchImpl = vi.fn(async () => response('{"result":1}'));
    await expect(createOperatorEligibilityAdmission({ ...env }, fetchImpl as never).admit(input)).resolves.toEqual({ outcome: "admitted" });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://safe-name.upstash.io/eval");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const payload = JSON.parse(String(init.body)) as [string, string, string, string];
    const digest = (domain: string, value: string) => createHmac("sha256", Buffer.from(secret, "base64url")).update(domain).update(Buffer.from([0])).update(value).digest("hex");
    expect(payload.slice(1)).toEqual(["0", digest("operator-mutation-admission:v1:session", input.sessionId), digest("operator-mutation-admission:v1:target", input.targetId)]);
    const remote = `${url}\n${JSON.stringify(init.headers)}\n${init.body}`;
    for (const raw of [input.sessionId, input.targetId, input.correlationId, input.origin, "reason", secret]) expect(remote).not.toContain(raw);
  });

  it.each([[1, "admitted"], [0, "limited"], [2, "unavailable"], ["1", "unavailable"], [null, "unavailable"]])("maps result %j to %s", async (result, outcome) => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify({ result })));
    await expect(createOperatorEligibilityAdmission({ ...env }, fetchImpl as never).admit(input)).resolves.toEqual({ outcome });
  });

  it.each([
    () => response("{}", 500), () => response("not-json"), () => response('{"result":1,"extra":0}'),
    () => response("x".repeat(4097)), () => response(Buffer.from([0xff])),
  ])("maps malformed/non-2xx/oversize/invalid UTF-8 to unavailable", async (factory) => {
    const fetchImpl = vi.fn(async () => factory());
    await expect(createOperatorEligibilityAdmission({ ...env }, fetchImpl as never).admit(input)).resolves.toEqual({ outcome: "unavailable" });
  });

  it("maps fetch throw and abort to unavailable without logging", async () => {
    const spies = [vi.spyOn(console, "log").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    for (const failure of [new Error("network"), new DOMException("timed out", "AbortError")]) {
      const fetchImpl = vi.fn(async () => { throw failure; });
      await expect(createOperatorEligibilityAdmission({ ...env }, fetchImpl as never).admit(input)).resolves.toEqual({ outcome: "unavailable" });
    }
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });

  it("fails hostile direct admission inputs closed without accessors, proxy traps, or remote fetch", async () => {
    const fetchImpl = vi.fn(async () => response('{"result":1}'));
    const admission = createOperatorEligibilityAdmission({ ...env }, fetchImpl as never);
    const getter = vi.fn(() => input.sessionId);
    const accessor = { ...input };
    Object.defineProperty(accessor, "sessionId", { enumerable: true, get: getter });
    const proxyCounts = { get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
    const proxy = new Proxy({}, {
      get() { proxyCounts.get++; throw new Error("get trap"); },
      getPrototypeOf() { proxyCounts.getPrototypeOf++; throw new Error("prototype trap"); },
      ownKeys() { proxyCounts.ownKeys++; throw new Error("keys trap"); },
      getOwnPropertyDescriptor() { proxyCounts.getOwnPropertyDescriptor++; throw new Error("descriptor trap"); },
    });
    const malformed: unknown[] = [
      proxy, accessor, { ...input, extra: true }, Object.assign(Object.create({ inherited: true }), input),
      { ...input, [Symbol("secret")]: true }, { ...input, sessionId: input.sessionId.toUpperCase() },
      { ...input, targetId: "not-a-uuid" }, { ...input, origin: `${input.origin}/` },
      { ...input, origin: "http://operator.example.test" }, { ...input, secFetchSite: "cross-site" },
      { ...input, correlationId: input.correlationId.toUpperCase() },
    ];
    for (const candidate of malformed) {
      await expect(admission.admit(candidate as never)).resolves.toEqual({ outcome: "unavailable" });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(proxyCounts).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
