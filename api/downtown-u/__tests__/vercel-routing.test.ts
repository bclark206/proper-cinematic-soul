import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  rewrites: Array<{ source: string; destination: string }>;
}

describe("Vercel Downtown U webhook routing", () => {
  it("places the exact webhook API rewrite before the SPA catch-all", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as VercelConfig;
    const webhookRoute = {
      source: "/api/downtown-u/square-webhook",
      destination: "/api/downtown-u/square-webhook",
    };
    const webhookIndex = config.rewrites.findIndex(
      (rewrite) =>
        rewrite.source === webhookRoute.source &&
        rewrite.destination === webhookRoute.destination,
    );
    const catchAllIndex = config.rewrites.findIndex(
      (rewrite) => rewrite.source === "/(.*)" && rewrite.destination === "/index.html",
    );

    expect(webhookIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThan(webhookIndex);
    expect(config.rewrites.filter((rewrite) => rewrite.source === webhookRoute.source)).toEqual([
      webhookRoute,
    ]);
  });
});
