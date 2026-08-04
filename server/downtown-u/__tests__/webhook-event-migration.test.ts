import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/202608040002_downtown_u_webhook_events.sql"), "utf8");

describe("webhook event migration security contract", () => {
  it("is transactional, payload-minimal, and grants only hardened function execution", () => {
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/raw_json|payload|signature|contact|email|phone/i);
    expect(sql).toMatch(/raw_body_sha256 TEXT NOT NULL/i);
    expect(sql).not.toMatch(/raw_body(?!_sha256)/i);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = pg_catalog/g);
    expect(sql).toMatch(/REVOKE ALL ON (?:TABLE )?public\.downtown_u_webhook_events FROM downtown_u_runtime/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_claim_webhook_event/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.downtown_u_claim_webhook_event/i);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|ALL).*downtown_u_webhook_events/i);
    expect(sql).toMatch(/INTERVAL '5 minutes'/i);
    expect(sql).toMatch(/existing\.status = 'processing'[\s\S]*attempt_count=e\.attempt_count\+1/i);
    expect(sql).toMatch(/NOT rolreplication/i);
    expect(sql).toMatch(/NOT rolbypassrls/i);
  });
});
