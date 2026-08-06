import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(`${process.cwd()}/vercel.json`, "utf8")) as {
  rewrites: Array<{source:string;destination:string}>;
  headers: Array<{source:string;headers:Array<{key:string;value:string}>}>;
};
const map = (source:string) => Object.fromEntries(config.headers.find(entry=>entry.source===source)!.headers.map(({key,value})=>[key,value]));

describe("embedded checkout Vercel document policy",()=>{
  it("routes checkout APIs before the SPA fallback",()=>{const fallback=config.rewrites.findIndex(r=>r.source==="/(.*)");for(const path of ["/api/downtown-u/checkout-config","/api/downtown-u/checkout"])expect(config.rewrites.findIndex(r=>r.source===path)).toBeLessThan(fallback);});
  it("applies a Square-compatible deny-by-default document policy to the SPA",()=>{const headers=map("/(.*)");const csp=headers["Content-Security-Policy"];expect(csp).toContain("frame-ancestors 'none'");expect(csp).toContain("base-uri 'self'");expect(csp).toContain("object-src 'none'");expect(csp).toContain("script-src 'self'");expect(csp).toContain("https://web.squarecdn.com");expect(csp).toContain("connect-src 'self' https://web.squarecdn.com https://pci-connect.squareup.com");expect(csp).toContain("frame-src https://web.squarecdn.com");expect(csp).not.toMatch(/unsafe-inline[^;]*web\.squarecdn|squareup\.com\/checkout/);expect(headers).toMatchObject({"Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"});expect(headers["Permissions-Policy"]).toContain("payment=(self \"https://web.squarecdn.com\")");
    const html=readFileSync(`${process.cwd()}/index.html`,"utf8");const inline=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>`sha256-${createHash("sha256").update(match[1]).digest("base64")}`);expect(inline.length).toBeGreaterThan(0);for(const hash of inline)expect(csp).toContain(`'${hash}'`);
  });
  it("keeps the auth verifier's exact stricter script hash and no-source policy last",()=>{const authIndex=config.headers.findIndex(h=>h.source==="/downtown-u/auth/verify");expect(authIndex).toBeGreaterThan(config.headers.findIndex(h=>h.source==="/(.*)"));const csp=map("/downtown-u/auth/verify")["Content-Security-Policy"];expect(csp).toContain("default-src 'none'");expect(csp).toContain("form-action 'none'");expect(csp).toContain("script-src 'sha256-");expect(csp).not.toContain("web.squarecdn.com");});
});
