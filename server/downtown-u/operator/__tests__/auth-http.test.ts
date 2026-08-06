import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_AUTH_RESPONSE_HEADERS,
  OPERATOR_SESSION_COOKIE_NAME,
  OperatorAuthBoundaryError,
  clearOperatorSessionCookie,
  parseOperatorAuthenticatedGet,
  parseOperatorPostRequest,
  parseOperatorPublicOrigin,
  parseOperatorSessionCookie,
  serializeOperatorSessionCookie,
} from "../auth-http";

const origin = "https://operator.example.test";
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const token = "A".repeat(43);

function rawRequest(method: string, body = "", headers: Record<string, string | string[] | undefined> = {}) {
  const stream = Readable.from(body === "" ? [] : [Buffer.from(body)]);
  return Object.assign(stream, { method, headers });
}

async function rejected(work: Promise<unknown>): Promise<OperatorAuthBoundaryError> {
  try { await work; throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(OperatorAuthBoundaryError); return error as OperatorAuthBoundaryError; }
}

describe("operator auth public origin", () => {
  it("accepts only a canonical HTTPS origin", () => {
    expect(parseOperatorPublicOrigin(origin)).toBe(origin);
    for (const value of [undefined, "", "http://operator.example.test", `${origin}/`, `${origin}/path`, `${origin}?x=1`, "https://u:p@example.test", "https://example.test/#x"])
      expect(() => parseOperatorPublicOrigin(value)).toThrow("Invalid operator public origin configuration");
  });
});

describe("operator auth POST raw boundary", () => {
  it("reads and validates exact endpoint schemas", async () => {
    const cases = [
      ["request-link", { email: "student@example.test" }],
      ["verify-email", { flowId: uuid, flowVerifier: token, challengeId: uuid, verifier: token }],
      ["verify-sms", { flowId: uuid, flowVerifier: token, challengeId: uuid, otp: "123456" }],
      ["logout", {}], ["reauth-request", {}], ["reauth-verify", { challengeId: uuid, otp: "123456" }],
    ] as const;
    for (const [endpoint, body] of cases) {
      const request = rawRequest("POST", JSON.stringify(body), { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" });
      expect(await parseOperatorPostRequest(request, endpoint, origin)).toEqual(body);
    }
    for (const endpoint of ["logout", "reauth-request"] as const) {
      for (const payload of ["", " ", "null", "[]", '{"extra":true}'])
        await rejected(parseOperatorPostRequest(rawRequest("POST", payload, { origin, "content-type": "application/json" }), endpoint, origin));
      await rejected(parseOperatorPostRequest(rawRequest("POST", "", { origin, "content-type": "application/json", "content-length": "0" }), endpoint, origin));
      expect(await parseOperatorPostRequest(rawRequest("POST", " \n\t{}\r ", { origin, "content-type": "application/json" }), endpoint, origin)).toEqual({});
    }
  });

  it("rejects method, origin, fetch metadata, and non-exact media type generically", async () => {
    const body = JSON.stringify({ email: "student@example.test" });
    const variants = [
      rawRequest("GET", body, { origin, "content-type": "application/json" }),
      rawRequest("POST", body, { "content-type": "application/json" }),
      rawRequest("POST", body, { origin: "https://evil.test", "content-type": "application/json" }),
      rawRequest("POST", body, { origin, "content-type": "application/json", "sec-fetch-site": "cross-site" }),
      rawRequest("POST", body, { origin, "content-type": "application/json; charset=utf-8" }),
      rawRequest("POST", body, { origin, "content-type": "Application/JSON" }),
    ];
    for (const request of variants) expect((await rejected(parseOperatorPostRequest(request, "request-link", origin))).message).toBe("Invalid operator auth request");
  });

  it("rejects duplicate, array, accessor, transfer-encoding, and pre-parsed inputs", async () => {
    const body = JSON.stringify({ email: "student@example.test" });
    const duplicateCase = rawRequest("POST", body, { origin, Origin: origin, "content-type": "application/json" });
    const array = rawRequest("POST", body, { origin: [origin], "content-type": "application/json" });
    const transfer = rawRequest("POST", body, { origin, "content-type": "application/json", "transfer-encoding": "chunked" });
    const rawDuplicate = Object.assign(rawRequest("POST", body, { origin, "content-type": "application/json" }), {
      rawHeaders: ["Origin", origin, "origin", origin, "Content-Type", "application/json"],
    });
    const preparsed = Object.assign(rawRequest("POST", body, { origin, "content-type": "application/json" }), { body: {} });
    const accessorHeaders = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorHeaders, "origin", { enumerable: true, get: () => { throw new Error("must not run"); } });
    accessorHeaders["content-type"] = "application/json";
    for (const request of [duplicateCase, array, transfer, rawDuplicate, preparsed, rawRequest("POST", body, accessorHeaders as never)])
      await rejected(parseOperatorPostRequest(request, "request-link", origin));
    await rejected(parseOperatorPostRequest({ method: "POST", headers: { origin, "content-type": "application/json" } }, "request-link", origin));
  });

  it("requires rawHeaders to agree exactly with normalized headers", async () => {
    const body = JSON.stringify({ email: "student@example.test" });
    const headers = { origin, "content-type": "application/json" };
    const matching = Object.assign(rawRequest("POST", body, headers), {
      rawHeaders: ["Origin", origin, "Content-Type", "application/json"],
    });
    await expect(parseOperatorPostRequest(matching, "request-link", origin)).resolves.toEqual({ email: "student@example.test" });

    const variants = [
      Object.assign(rawRequest("POST", body, headers), { rawHeaders: ["Origin", "https://evil.test", "Content-Type", "application/json"] }),
      Object.assign(rawRequest("POST", body, headers), { rawHeaders: ["Origin", origin, "Content-Type", "application/json", "X-Raw-Only", "1"] }),
      Object.assign(rawRequest("POST", body, { ...headers, "x-normalized-only": "1" }), { rawHeaders: ["Origin", origin, "Content-Type", "application/json"] }),
    ];
    for (const request of variants) await rejected(parseOperatorPostRequest(request, "request-link", origin));
  });

  it("rejects oversized, malformed UTF-8/JSON, duplicate keys, arrays, prototypes and schema/value errors", async () => {
    const baseHeaders = { origin, "content-type": "application/json" };
    const malformedUtf8 = Object.assign(Readable.from([Buffer.from([0xc3, 0x28])]), { method: "POST", headers: baseHeaders });
    const payloads = [" ", "{", "[]", '{"email":"a@b.test","email":"c@d.test"}', '{"__proto__":{},"email":"a@b.test"}',
      '{"email":"Student@Example.test"}', '{"email":"student@example.test","extra":true}', JSON.stringify({ email: "a".repeat(8_193) })];
    await rejected(parseOperatorPostRequest(malformedUtf8, "request-link", origin));
    for (const payload of payloads) await rejected(parseOperatorPostRequest(rawRequest("POST", payload, baseHeaders), "request-link", origin));
  });
});

describe("operator auth GET and cookie boundary", () => {
  it("allows only bodyless same-origin/originless authenticated GET", async () => {
    await expect(parseOperatorAuthenticatedGet(rawRequest("GET", "", {}), origin)).resolves.toBeUndefined();
    await expect(parseOperatorAuthenticatedGet(rawRequest("GET", "", { origin, "sec-fetch-site": "same-origin" }), origin)).resolves.toBeUndefined();
    for (const request of [rawRequest("POST"), rawRequest("GET", "x"), rawRequest("GET", "", { origin: "https://evil.test" }),
      rawRequest("GET", "", { "sec-fetch-site": "same-site" }), rawRequest("GET", "", { "content-type": "application/json" }),
      rawRequest("GET", "", { "transfer-encoding": "chunked" }), rawRequest("GET", "", { "content-length": "0" })])
      await expect(parseOperatorAuthenticatedGet(request, origin)).rejects.toBeInstanceOf(OperatorAuthBoundaryError);
  });

  it("parses only the exact host operator cookie and rejects cookie ambiguity", () => {
    const value = `v1.${uuid}.${token}`;
    expect(parseOperatorSessionCookie(`x=1; ${OPERATOR_SESSION_COOKIE_NAME}=${value}`)).toEqual({ sessionId: uuid, bearer: token });
    for (const raw of [undefined, "", `${OPERATOR_SESSION_COOKIE_NAME}=v2.${uuid}.${token}`,
      `${OPERATOR_SESSION_COOKIE_NAME}=${value}; ${OPERATOR_SESSION_COOKIE_NAME}=${value}`,
      [`${OPERATOR_SESSION_COOKIE_NAME}=${value}`], `${OPERATOR_SESSION_COOKIE_NAME}=${value}\r`, "x=" + "a".repeat(4097),
      `downtown_u_session=${value}`]) expect(parseOperatorSessionCookie(raw)).toBeNull();
  });

  it("serializes bounded secure cookies without leaking values into errors", () => {
    expect(serializeOperatorSessionCookie(uuid, token, 28_800)).toBe(`${OPERATOR_SESSION_COOKIE_NAME}=v1.${uuid}.${token}; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict`);
    expect(clearOperatorSessionCookie()).toBe(`${OPERATOR_SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
    for (const ttl of [0, -1, 28_801, 1.5, Number.NaN]) expect(() => serializeOperatorSessionCookie(uuid, token, ttl)).toThrow("Invalid operator session cookie");
    expect(() => serializeOperatorSessionCookie(uuid, "secret-value", 1)).toThrow("Invalid operator session cookie");
  });
});

describe("operator auth security response headers", () => {
  it("defines immutable no-store headers for success and error responses", () => {
    expect(OPERATOR_AUTH_RESPONSE_HEADERS).toEqual({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    expect(Object.isFrozen(OPERATOR_AUTH_RESPONSE_HEADERS)).toBe(true);
  });
});
