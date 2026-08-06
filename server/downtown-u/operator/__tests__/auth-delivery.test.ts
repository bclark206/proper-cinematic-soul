import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperatorAuthDeliveryConfigurationError,
  OperatorAuthDeliveryError,
  sendOperatorMagicLink,
  sendOperatorSmsOtp,
  type OperatorAuthDeliveryDependencies,
} from "../auth-delivery";

const FLOW_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHALLENGE_ID = "8327c0ae-9f10-4d2f-9f43-10fd31bcd734";
const FLOW_VERIFIER = "F".repeat(43);
const CHALLENGE_VERIFIER = "c".repeat(43);
const SID = `AC${"a".repeat(32)}`;
const EMAIL = "operator@example.test";
const PHONE = "+14155550123";

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emailDependencies(fetchImpl: typeof fetch, extra: NodeJS.ProcessEnv = {}): OperatorAuthDeliveryDependencies {
  return {
    fetch: fetchImpl,
    env: {
      RESEND_API_KEY: "re_test_secret",
      DOWNTOWN_U_OPERATOR_AUTH_EMAIL_FROM: "Downtown U Operators <operators@example.test>",
      ...extra,
    },
  };
}

function smsDependencies(fetchImpl: typeof fetch, extra: NodeJS.ProcessEnv = {}): OperatorAuthDeliveryDependencies {
  return {
    fetch: fetchImpl,
    env: {
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: "twilio_test_secret",
      DOWNTOWN_U_OPERATOR_AUTH_SMS_FROM: "+14155550999",
      ...extra,
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("operator authentication delivery", () => {
  it("sends a Resend magic link whose route and every credential are fragment-only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseJson({ id: "email_123" }));

    await sendOperatorMagicLink({
      normalizedEmail: EMAIL,
      publicOrigin: "https://operators.example.test",
      flowId: FLOW_ID,
      flowVerifier: FLOW_VERIFIER,
      challengeId: CHALLENGE_ID,
      challengeVerifier: CHALLENGE_VERIFIER,
    }, emailDependencies(fetchMock));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer re_test_secret",
      "Content-Type": "application/json",
    });
    const payload = JSON.parse(String(init?.body)) as {
      from: string; to: string[]; subject: string; text: string;
    };
    expect(payload.from).toBe("Downtown U Operators <operators@example.test>");
    expect(payload.to).toEqual([EMAIL]);
    expect(payload.subject).toBe("Downtown U operator sign-in");
    expect(payload.subject).not.toMatch(/550e8400|8327c0ae|FFFF|cccc/);
    expect(payload.text.length).toBeLessThan(1_000);

    const link = payload.text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeDefined();
    const parsed = new URL(link!);
    expect(parsed.origin).toBe("https://operators.example.test");
    expect(parsed.pathname).toBe("/downtown-u/operator/auth");
    expect(parsed.search).toBe("");
    const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
    expect([...fragmentParams.entries()]).toEqual([
      ["flowId", FLOW_ID],
      ["flowVerifier", FLOW_VERIFIER],
      ["challengeId", CHALLENGE_ID],
      ["verifier", CHALLENGE_VERIFIER],
    ]);
    expect(fragmentParams.size).toBe(4);
    const serverRequestTarget = `${parsed.pathname}${parsed.search}`;
    for (const credential of [FLOW_ID, FLOW_VERIFIER, CHALLENGE_ID, CHALLENGE_VERIFIER]) {
      expect(serverRequestTarget).not.toContain(credential);
    }
  });

  it("uses the exact Twilio endpoint, Basic auth, form encoding, and bounded OTP body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseJson({ sid: `SM${"b".repeat(32)}` }, 201));

    await sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" }, smsDependencies(fetchMock));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`${SID}:twilio_test_secret`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    });
    const form = new URLSearchParams(String(init?.body));
    expect([...form.keys()]).toEqual(["To", "From", "Body"]);
    expect(form.get("To")).toBe(PHONE);
    expect(form.get("From")).toBe("+14155550999");
    expect(form.get("Body")).toBe("Downtown U operator verification code: 123456. Expires in 5 minutes.");
    expect(form.get("Body")).not.toContain(PHONE);
  });

  it("allows the bounded reauthentication wording", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseJson({ sid: `SM${"b".repeat(32)}` }, 201));
    await sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "654321", purpose: "reauth" }, smsDependencies(fetchMock));
    const form = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(form.get("Body")).toBe("Downtown U operator reauthentication code: 654321. Expires in 5 minutes.");
  });

  it("loads provider configuration endpoint-narrowly and never uses student sender fallbacks", async () => {
    const emailFetch = vi.fn<typeof fetch>().mockResolvedValue(responseJson({ id: "email_123" }));
    await expect(sendOperatorMagicLink({
      normalizedEmail: EMAIL, publicOrigin: "https://operators.example.test",
      flowId: FLOW_ID, flowVerifier: FLOW_VERIFIER,
      challengeId: CHALLENGE_ID, challengeVerifier: CHALLENGE_VERIFIER,
    }, emailDependencies(emailFetch, {
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      DOWNTOWN_U_OPERATOR_AUTH_SMS_FROM: undefined,
      DOWNTOWN_U_AUTH_EMAIL_FROM: "student@example.test",
    }))).resolves.toBeUndefined();

    const smsFetch = vi.fn<typeof fetch>().mockResolvedValue(responseJson({ sid: `SM${"b".repeat(32)}` }, 201));
    await expect(sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" }, smsDependencies(smsFetch, {
      RESEND_API_KEY: undefined,
      DOWNTOWN_U_OPERATOR_AUTH_EMAIL_FROM: undefined,
      DOWNTOWN_U_AUTH_SMS_FROM: "+14155550888",
    }))).resolves.toBeUndefined();

    await expect(sendOperatorMagicLink({
      normalizedEmail: EMAIL, publicOrigin: "https://operators.example.test",
      flowId: FLOW_ID, flowVerifier: FLOW_VERIFIER,
      challengeId: CHALLENGE_ID, challengeVerifier: CHALLENGE_VERIFIER,
    }, { fetch: emailFetch, env: { RESEND_API_KEY: "key", DOWNTOWN_U_AUTH_EMAIL_FROM: "student@example.test" } }))
      .rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
    await expect(sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" }, {
      fetch: smsFetch,
      env: { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "token", DOWNTOWN_U_AUTH_SMS_FROM: "+14155550888" },
    })).rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
  });

  it("rejects non-HTTPS or non-origin URLs and malformed input before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const base = {
      normalizedEmail: EMAIL, flowId: FLOW_ID, flowVerifier: FLOW_VERIFIER,
      challengeId: CHALLENGE_ID, challengeVerifier: CHALLENGE_VERIFIER,
    };
    for (const publicOrigin of ["http://operators.example.test", "https://operators.example.test/path", "https://user@operators.example.test", "not-a-url"]) {
      await expect(sendOperatorMagicLink({ ...base, publicOrigin }, emailDependencies(fetchMock))).rejects.toBeInstanceOf(OperatorAuthDeliveryError);
    }
    for (const input of [
      { ...base, publicOrigin: "https://operators.example.test", normalizedEmail: "Operator@example.test" },
      { ...base, publicOrigin: "https://operators.example.test", flowId: "not-a-uuid" },
      { ...base, publicOrigin: "https://operators.example.test", challengeId: "not-a-uuid" },
      { ...base, publicOrigin: "https://operators.example.test", flowVerifier: "short" },
      { ...base, publicOrigin: "https://operators.example.test", challengeVerifier: "bad+base64/padding=" },
    ]) {
      await expect(sendOperatorMagicLink(input, emailDependencies(fetchMock))).rejects.toBeInstanceOf(OperatorAuthDeliveryError);
    }
    for (const input of [
      { normalizedPhone: "4155550123", otp: "123456", purpose: "sign_in" as const },
      { normalizedPhone: "+012345678", otp: "123456", purpose: "sign_in" as const },
      { normalizedPhone: PHONE, otp: "12345", purpose: "sign_in" as const },
      { normalizedPhone: PHONE, otp: "12345a", purpose: "sign_in" as const },
      { normalizedPhone: PHONE, otp: "123456", purpose: "reset" as "sign_in" },
    ]) {
      await expect(sendOperatorSmsOtp(input, smsDependencies(fetchMock))).rejects.toBeInstanceOf(OperatorAuthDeliveryError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed or missing provider configuration without fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const emailInput = {
      normalizedEmail: EMAIL, publicOrigin: "https://operators.example.test",
      flowId: FLOW_ID, flowVerifier: FLOW_VERIFIER,
      challengeId: CHALLENGE_ID, challengeVerifier: CHALLENGE_VERIFIER,
    };
    await expect(sendOperatorMagicLink(emailInput, { fetch: fetchMock, env: {} }))
      .rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
    await expect(sendOperatorMagicLink(emailInput, emailDependencies(fetchMock, { RESEND_API_KEY: "bad\nkey" })))
      .rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
    await expect(sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" }, {
      fetch: fetchMock, env: { TWILIO_ACCOUNT_SID: "bad", TWILIO_AUTH_TOKEN: "token", DOWNTOWN_U_OPERATOR_AUTH_SMS_FROM: PHONE },
    })).rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the bounded timeout, aborts, and performs no automatic retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("provider included a secret", "AbortError")), { once: true });
    }));
    const promise = sendOperatorSmsOtp(
      { normalizedPhone: PHONE, otp: "987654", purpose: "sign_in" },
      smsDependencies(fetchMock, { DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS: "100" }),
    );
    const rejection = expect(promise).rejects.toEqual(new OperatorAuthDeliveryError());
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("rejects malformed timeout config before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const timeout of ["0", "99", "30001", "1.5", "nope"]) {
      await expect(sendOperatorSmsOtp(
        { normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" },
        smsDependencies(fetchMock, { DOWNTOWN_U_AUTH_PROVIDER_TIMEOUT_MS: timeout }),
      )).rejects.toBeInstanceOf(OperatorAuthDeliveryConfigurationError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds and validates provider responses and never retries", async () => {
    for (const response of [
      new Response("x".repeat(4_097), { status: 200 }),
      new Response("{malformed", { status: 200 }),
      responseJson({ unexpected: true }),
      responseJson({ error: "provider reflected operator@example.test and 123456" }, 500),
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(sendOperatorMagicLink({
        normalizedEmail: EMAIL, publicOrigin: "https://operators.example.test",
        flowId: FLOW_ID, flowVerifier: FLOW_VERIFIER,
        challengeId: CHALLENGE_ID, challengeVerifier: CHALLENGE_VERIFIER,
      }, emailDependencies(fetchMock))).rejects.toEqual(new OperatorAuthDeliveryError());
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("returns only generic errors that redact contact, credentials, OTP, and provider text", async () => {
    const providerText = "provider leaked operator@example.test 123456 FFFFF secret";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(providerText, { status: 401 }));
    let caught: unknown;
    try {
      await sendOperatorSmsOtp({ normalizedPhone: PHONE, otp: "123456", purpose: "sign_in" }, smsDependencies(fetchMock));
    } catch (error) { caught = error; }
    expect(caught).toEqual(new OperatorAuthDeliveryError());
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
    for (const secret of [PHONE, "123456", "operator@example.test", "FFFFF", "provider leaked", "twilio_test_secret"]) {
      expect(rendered).not.toContain(secret);
    }
  });
});
