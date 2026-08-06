import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  rewrites: Array<{ source: string; destination: string }>;
  crons: Array<{ path: string; schedule: string }>;
}

describe("Vercel Downtown U API routing", () => {
  it("places exact Downtown U API rewrites before the SPA catch-all", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as VercelConfig;
    const catchAllIndex = config.rewrites.findIndex(
      (rewrite) => rewrite.source === "/(.*)" && rewrite.destination === "/index.html",
    );

    const paths = ["square-webhook", "request-link", "send-code", "verify-code", "me", "meals", "purchases", "reservations", "reservations/:id/cancel", "logout", "jobs/expire-reservations", "jobs/process-kitchen-orders"];
    for (const path of paths) {
      const route = { source: `/api/downtown-u/${path}`, destination: `/api/downtown-u/${path}` };
      const index = config.rewrites.findIndex((rewrite) => rewrite.source === route.source && rewrite.destination === route.destination);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(catchAllIndex).toBeGreaterThan(index);
      expect(config.rewrites.filter((rewrite) => rewrite.source === route.source)).toEqual([route]);
    }
    expect(catchAllIndex).toBe(config.rewrites.length - 1);
  });
  it("schedules both authenticated bounded jobs",()=>{const config=JSON.parse(readFileSync(resolve(process.cwd(),"vercel.json"),"utf8")) as VercelConfig;expect(config.crons).toEqual([{path:"/api/downtown-u/jobs/expire-reservations",schedule:"*/5 * * * *"},{path:"/api/downtown-u/jobs/process-kitchen-orders",schedule:"* * * * *"}])});
});
