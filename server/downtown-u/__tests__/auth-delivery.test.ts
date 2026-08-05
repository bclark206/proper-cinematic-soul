import { describe, expect, it, vi } from "vitest";
import {
  AuthDeliveryError, createAuthDeliverySink, createEmailAuthDeliveryFromEnvironment, createMagicLink,
  createResendEmailProvider, createSmsAuthDeliveryFromEnvironment, createTwilioSmsProvider,
} from "../auth-delivery";

const challengeId = "A".repeat(43); const verifier = "b".repeat(43);
const expiry = new Date(Date.now() + 600_000);

describe("authentication delivery boundaries", () => {
  it("builds a fixed HTTPS magic link with credentials exclusively in the fragment", () => {
    const link = createMagicLink("https://app.example.test", challengeId, verifier);
    expect(link).toBe(`https://app.example.test/downtown-u/auth/verify#challengeId=${challengeId}&verifier=${verifier}`);
    const parsed = new URL(link);
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/downtown-u/auth/verify");
    expect(parsed.hash).toBe(`#${new URLSearchParams({ challengeId, verifier }).toString()}`);
    expect(`${parsed.pathname}${parsed.search}`).not.toContain(challengeId);
    expect(`${parsed.pathname}${parsed.search}`).not.toContain(verifier);
    expect(() => createMagicLink("http://app.example.test", challengeId, verifier)).toThrow();
    expect(() => createMagicLink("https://app.example.test/redirect", challengeId, verifier)).toThrow();
  });

  it("dispatches each method once through only its narrow provider", async () => {
    const email = { send: vi.fn().mockResolvedValue(undefined) }; const sms = { send: vi.fn().mockResolvedValue(undefined) };
    const sink = createAuthDeliverySink({ publicAppOrigin: "https://app.example.test", email, sms });
    await sink.deliver({ challengeId, method: "email_magic_link", normalizedContact: "student@example.test", verifier, expiresAt: expiry });
    await sink.deliver({ challengeId, method: "sms_otp", normalizedContact: "+12025550100", verifier: "012345", expiresAt: expiry });
    expect(email.send).toHaveBeenCalledOnce(); expect(email.send.mock.calls[0][0]).toEqual({ to: "student@example.test", expiresAt: expiry,
      magicLink: `https://app.example.test/downtown-u/auth/verify#challengeId=${challengeId}&verifier=${verifier}` });
    expect(sms.send).toHaveBeenCalledOnce(); expect(sms.send).toHaveBeenCalledWith({
      to: "+12025550100", otp: "012345", challengeId, expiresAt: expiry,
    });
  });

  it("uses exact provider endpoints/auth and performs no retry on non-2xx", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("provider secret details", { status: 500 }));
    const email = createResendEmailProvider({ apiKey: "resend-secret", from: "Sign in <auth@example.test>", fetch: fetchMock });
    await expect(email.send({ to: "student@example.test", magicLink: "https://app.example.test/link", expiresAt: expiry }))
      .rejects.toEqual(new AuthDeliveryError("provider"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]; expect(url).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer resend-secret");
    const payload = JSON.parse(String(init?.body)) as { to: string[]; text: string };
    expect(payload.to).toEqual(["student@example.test"]); expect(payload.text).toContain("https://app.example.test/link");
  });

  it("encodes Twilio form fields and authorization without putting the phone in SMS content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    const sid = `AC${"a".repeat(32)}`;
    const sms = createTwilioSmsProvider({ accountSid: sid, authToken: "twilio-secret", from: "+12025550199", fetch: fetchMock });
    await sms.send({ to: "+12025550100", otp: "012345", challengeId, expiresAt: expiry });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("To")).toBe("+12025550100"); expect(form.get("From")).toBe("+12025550199");
    expect(form.get("Body")).toBe(`Your Downtown U code is 012345. Sign-in reference: ${challengeId}. It expires in 10 minutes.`);
    expect(form.get("Body")).not.toContain("+12025550100");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${sid}:twilio-secret`).toString("base64")}`);
  });

  it("fails closed on malformed provider config", () => {
    expect(() => createResendEmailProvider({ apiKey: "x\nAuthorization: bad", from: "a@b.test" })).toThrow();
    expect(() => createTwilioSmsProvider({ accountSid: "bad", authToken: "secret", from: "+12025550100" })).toThrow();
  });

  it("bounds provider responses and aborts timed-out sends without retrying", async () => {
    const oversizedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(4_097), { status: 200 }));
    const oversized = createResendEmailProvider({ apiKey: "key", from: "a@b.test", fetch: oversizedFetch });
    await expect(oversized.send({ to: "student@example.test", magicLink: "https://app.example.test/link", expiresAt: expiry }))
      .rejects.toEqual(new AuthDeliveryError("provider"));
    expect(oversizedFetch).toHaveBeenCalledOnce();

    const hangingFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("secret provider detail", "AbortError")), { once: true });
    }));
    const timed = createResendEmailProvider({ apiKey: "key", from: "a@b.test", fetch: hangingFetch, timeoutMs: 1 });
    await expect(timed.send({ to: "student@example.test", magicLink: "https://app.example.test/link", expiresAt: expiry }))
      .rejects.toEqual(new AuthDeliveryError("timeout"));
    expect(hangingFetch).toHaveBeenCalledOnce();
  });

  it("constructs endpoint-narrow environment sinks without the unrelated provider", () => {
    expect(() => createEmailAuthDeliveryFromEnvironment({
      DOWNTOWN_U_PUBLIC_APP_ORIGIN: "https://app.example.test",
      RESEND_API_KEY: "resend-key", DOWNTOWN_U_AUTH_EMAIL_FROM: "auth@example.test",
      // No Twilio variables.
    })).not.toThrow();
    expect(() => createSmsAuthDeliveryFromEnvironment({
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "twilio-key", DOWNTOWN_U_AUTH_SMS_FROM: "+12025550199",
      // No Resend variables or app origin.
    })).not.toThrow();
  });

  it("keeps required provider configuration fail-closed and narrow method dispatch strict", async () => {
    expect(() => createEmailAuthDeliveryFromEnvironment({ DOWNTOWN_U_PUBLIC_APP_ORIGIN: "https://app.example.test" })).toThrow();
    expect(() => createSmsAuthDeliveryFromEnvironment({})).toThrow();

    const emailSink = createEmailAuthDeliveryFromEnvironment({
      DOWNTOWN_U_PUBLIC_APP_ORIGIN: "https://app.example.test",
      RESEND_API_KEY: "resend-key", DOWNTOWN_U_AUTH_EMAIL_FROM: "auth@example.test",
    });
    await expect(emailSink.deliver({ challengeId, method: "sms_otp", normalizedContact: "+12025550100",
      verifier: "123456", expiresAt: expiry })).rejects.toEqual(new AuthDeliveryError("provider"));
    const smsSink = createSmsAuthDeliveryFromEnvironment({
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "twilio-key",
      DOWNTOWN_U_AUTH_SMS_FROM: "+12025550199",
    });
    await expect(smsSink.deliver({ challengeId, method: "email_magic_link", normalizedContact: "a@b.test",
      verifier, expiresAt: expiry })).rejects.toEqual(new AuthDeliveryError("provider"));
  });
});
