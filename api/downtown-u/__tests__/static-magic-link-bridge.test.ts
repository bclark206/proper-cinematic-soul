import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(process.cwd(), "public/downtown-u-auth-verify.html"), "utf8");
const parsed = new DOMParser().parseFromString(html, "text/html");
const scripts = Array.from(parsed.querySelectorAll("script"));
const script = scripts[0]?.textContent ?? "";

interface MockLocation {
  hash: string;
  pathname: string;
  search: string;
  replace: ReturnType<typeof vi.fn>;
}

async function executeBridge(hash: string, response: Promise<{ ok: boolean }> = Promise.resolve({ ok: true })) {
  const events: string[] = [];
  const location: MockLocation = {
    hash,
    pathname: "/downtown-u/auth/verify",
    search: "?challengeId=must-not-survive",
    replace: vi.fn((target: string) => events.push(`navigate:${target}`)),
  };
  const history = {
    replaceState: vi.fn((_state: null, _title: string, target: string) => {
      events.push(`scrub:${target}`);
      location.hash = "";
      location.search = "";
    }),
  };
  const fetch = vi.fn((url: string, init: RequestInit) => {
    events.push(`fetch:${url}`);
    return response;
  });

  new Function("location", "history", "fetch", script)(location, history, fetch);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return { events, fetch, history, location };
}

describe("static Downtown U magic-link bridge", () => {
  it("is self-contained and binds its sole inline script to the CSP hash", () => {
    expect(scripts).toHaveLength(1);
    expect(scripts[0].hasAttribute("src")).toBe(false);
    expect(parsed.querySelectorAll("link, style, img, iframe, object, embed, audio, video, source")).toHaveLength(0);
    expect(parsed.querySelectorAll("[src], link[href]")).toHaveLength(0);
    expect(html).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|analytics/i);

    const hash = createHash("sha256").update(script).digest("base64");
    const policy = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(parsed.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(parsed.body.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Verifying your sign-in Please wait while we securely verify your link.",
    );
  });

  it("reads then synchronously removes the fragment and query before the only fetch", async () => {
    const readIndex = script.indexOf("let fragment = location.hash;");
    const scrubIndex = script.indexOf('history.replaceState(null, "", location.pathname);');
    const fetchIndex = script.indexOf('fetch("/api/downtown-u/verify-code"');
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(scrubIndex).toBeGreaterThan(readIndex);
    expect(fetchIndex).toBeGreaterThan(scrubIndex);

    const challengeId = "A".repeat(43);
    const verifier = "b".repeat(43);
    const result = await executeBridge(`#challengeId=${challengeId}&verifier=${verifier}`);

    expect(result.events.slice(0, 2)).toEqual([
      "scrub:/downtown-u/auth/verify",
      "fetch:/api/downtown-u/verify-code",
    ]);
    expect(result.history.replaceState).toHaveBeenCalledTimes(1);
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(result.fetch).toHaveBeenCalledWith("/api/downtown-u/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, verifier }),
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
    expect(result.location.hash).toBe("");
    expect(result.location.search).toBe("");
    expect(result.location.replace).toHaveBeenCalledWith("/downtown-u?auth=success");
    expect(result.location.replace.mock.calls.flat().join(" ")).not.toContain(challengeId);
    expect(parsed.body.textContent).not.toContain(challengeId);
    expect(parsed.body.textContent).not.toContain(verifier);
  });

  it("accepts a six-digit verifier and handles API failure generically", async () => {
    const challengeId = "_".repeat(43);
    const result = await executeBridge(
      `#challengeId=${challengeId}&verifier=123456`,
      Promise.resolve({ ok: false }),
    );
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(result.location.replace).toHaveBeenCalledWith("/downtown-u?auth=invalid");
  });

  it.each([
    ["missing fragment", ""],
    ["missing verifier", `#challengeId=${"A".repeat(43)}`],
    ["short challenge", `#challengeId=${"A".repeat(42)}&verifier=${"B".repeat(43)}`],
    ["long challenge", `#challengeId=${"A".repeat(44)}&verifier=${"B".repeat(43)}`],
    ["invalid challenge alphabet", `#challengeId=${"A".repeat(42)}%2B&verifier=${"B".repeat(43)}`],
    ["short verifier", `#challengeId=${"A".repeat(43)}&verifier=${"B".repeat(42)}`],
    ["non-six-digit OTP", `#challengeId=${"A".repeat(43)}&verifier=12345x`],
    ["extra key", `#challengeId=${"A".repeat(43)}&verifier=${"B".repeat(43)}&next=evil`],
    ["duplicate key", `#challengeId=${"A".repeat(43)}&challengeId=${"C".repeat(43)}&verifier=${"B".repeat(43)}`],
    ["wrong key casing", `#challengeid=${"A".repeat(43)}&verifier=${"B".repeat(43)}`],
  ])("rejects %s without calling the API", async (_label, hash) => {
    const result = await executeBridge(hash);
    expect(result.events[0]).toBe("scrub:/downtown-u/auth/verify");
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.location.replace).toHaveBeenCalledTimes(1);
    expect(result.location.replace).toHaveBeenCalledWith("/downtown-u?auth=invalid");
  });

  it("uses fixed navigation after a network rejection without exposing the error", async () => {
    const result = await executeBridge(
      `#challengeId=${"A".repeat(43)}&verifier=${"B".repeat(43)}`,
      Promise.reject(new Error("credential-bearing provider detail")),
    );
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(result.location.replace).toHaveBeenCalledWith("/downtown-u?auth=invalid");
    expect(result.location.replace.mock.calls.flat().join(" ")).not.toContain("provider detail");
  });
});

describe("static bridge Vercel routing and headers", () => {
  it("puts the exact bridge rewrite before the SPA fallback and applies exact-path headers", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
      rewrites: Array<{ source: string; destination: string }>;
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const route = { source: "/downtown-u/auth/verify", destination: "/downtown-u-auth-verify.html" };
    const routeIndex = config.rewrites.findIndex((item) => item.source === route.source);
    const fallbackIndex = config.rewrites.findIndex((item) => item.source === "/(.*)");
    expect(config.rewrites.filter((item) => item.source === route.source)).toEqual([route]);
    expect(routeIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackIndex).toBeGreaterThan(routeIndex);

    const rules = config.headers.filter((item) => item.source === route.source);
    expect(rules).toHaveLength(1);
    const headers = Object.fromEntries(rules[0].headers.map(({ key, value }) => [key, value]));
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    const hash = createHash("sha256").update(script).digest("base64");
    expect(headers["Content-Security-Policy"]).toContain(`script-src 'sha256-${hash}'`);
  });
});
