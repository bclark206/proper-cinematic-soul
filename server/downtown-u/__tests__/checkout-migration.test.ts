import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/202608040007_downtown_u_checkout.sql"), "utf8");
const retentionScript = readFileSync(resolve(process.cwd(), "scripts/downtown-u-checkout-retention.sh"), "utf8");
const runbook = readFileSync(resolve(process.cwd(), "docs/downtown-u-square-checkout.md"), "utf8");

describe("Downtown U checkout migration contract", () => {
  it("supports global admission and terminal retention scans", () => {
    expect(sql).toContain("CREATE INDEX downtown_u_checkout_created_idx ON public.downtown_u_checkout_attempts(created_at)");
    expect(sql).toContain("WHERE state IN ('activated','operator_review','failed')");
  });

  it("provides bounded owner-only PII anonymization without deleting audit identity", () => {
    expect(sql).toContain("normalized_email TEXT CHECK");
    expect(sql).toContain("request_actor BYTEA CHECK");
    expect(sql).toContain("redacted_at TIMESTAMPTZ");
    expect(sql).toContain("CREATE FUNCTION public.downtown_u_checkout_anonymize(requested_limit INTEGER)");
    expect(sql).toContain("state IN ('activated','operator_review','failed')");
    expect(sql).toContain("created_at < now_at-interval '90 days'");
    expect(sql).toContain("WHEN x.state IN ('started','order_created','payment_created','paid') THEN 'operator_review'");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.downtown_u_checkout_anonymize(INTEGER) FROM PUBLIC,downtown_u_runtime,downtown_u_jobs");
    expect(sql).not.toMatch(/DELETE FROM public\.downtown_u_checkout_attempts/i);
  });

  it("ships a bounded owner-controlled weekly retention path without command-line credentials", () => {
    expect(retentionScript).toContain("DOWNTOWN_U_MIGRATION_PGSERVICE");
    expect(retentionScript).toContain("service=${service}");
    expect(retentionScript).toContain("downtown_u_checkout_anonymize(:batch_size::integer)");
    expect(retentionScript).not.toMatch(/DATABASE_URL|PASSWORD|postgres(?:ql)?:\/\//i);
    expect(runbook).toContain("17 3 * * 0");
    expect(runbook).toContain("Checkout must remain disabled if this owner-controlled schedule is not installed and tested");
  });

  it("leaves one-ID order races pending until payment identity is durable", () => {
    expect(sql).toContain("x.square_payment_id IS NOT NULL");
    expect(sql).toContain("x.square_order_id=NEW.square_order_id AND x.square_payment_id=NEW.square_payment_id");
  });
});
