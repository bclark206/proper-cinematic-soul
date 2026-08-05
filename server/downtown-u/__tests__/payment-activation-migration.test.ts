import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/202608040003_downtown_u_payment_activation.sql"), "utf8");

describe("payment activation forward migration", () => {
  it("is transactional, stores the exact immutable authoritative signature, and exposes only atomic activation", () => {
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toMatch(/ADD COLUMN authoritative_paid_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN authoritative_normalized_email TEXT/i);
    expect(sql).toMatch(/ADD COLUMN authoritative_normalized_phone TEXT/i);
    expect(sql).toMatch(/ADD COLUMN authoritative_square_customer_id TEXT/i);
    expect(sql).toMatch(/authoritative_normalized_email[\s\S]*length\(authoritative_normalized_email\) <= 254/i);
    expect(sql).toMatch(/authoritative_normalized_phone[\s\S]*\^\[\+\]/i);
    expect(sql).toMatch(/authoritative_square_customer_id[\s\S]*length\(authoritative_square_customer_id\)/i);
    expect(sql).toMatch(/authoritative_paid_at IS DISTINCT FROM OLD\.authoritative_paid_at/i);
    for (const column of ["authoritative_normalized_email", "authoritative_normalized_phone", "authoritative_square_customer_id"]) {
      expect(sql).toMatch(new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`, "i"));
    }
    expect(sql).toMatch(/REVOKE INSERT \([^)]*authoritative_normalized_email[^)]*authoritative_normalized_phone[^)]*authoritative_square_customer_id[^)]*\)[\s\S]*downtown_u_plan_purchases/i);
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*authoritative_(?:normalized_email|normalized_phone|square_customer_id)/i);
    expect(sql).toMatch(/downtown_u_activate_verified_payment[\s\S]*e\.claim_token = requested_claim_token[\s\S]*FOR UPDATE/i);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = pg_catalog/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_activate_verified_payment/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.downtown_u_activate_verified_payment/i);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|ALL).*downtown_u_webhook_events/i);
    expect(sql).not.toMatch(/payload|raw_json|signature/i);
  });

  it("replaces the exact phase-one contact constraint with customer-aware authoritative identity", () => {
    expect(sql).toMatch(/ALTER TABLE public\.downtown_u_students\s+DROP CONSTRAINT downtown_u_students_check\s*;/i);
    expect(sql).toMatch(/ADD CONSTRAINT downtown_u_students_check\s+CHECK\s*\(\s*normalized_email IS NOT NULL\s+OR normalized_phone IS NOT NULL\s+OR square_customer_id IS NOT NULL\s*\)/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS downtown_u_students_check/i);
    expect(sql).toMatch(/ADD CONSTRAINT downtown_u_students_square_customer_id_format[\s\S]*length\(square_customer_id\) BETWEEN 1 AND 192[\s\S]*\^\[A-Za-z0-9_-\]\+\$/i);
  });

  it("adds a terminal token-bound rejection without making failed claims terminal", () => {
    expect(sql).toMatch(/status IN \('new', 'processing', 'completed', 'failed', 'rejected'\)/);
    expect(sql).toMatch(/existing\.status IN \('completed', 'rejected'\)[\s\S]*'duplicate'/);
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_reject_webhook_event/);
    expect(sql).toMatch(/e\.status='processing'[\s\S]*e\.claim_token=requested_claim_token/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_reject_webhook_event[^;]*FROM PUBLIC, downtown_u_runtime/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.downtown_u_reject_webhook_event[^;]*TO downtown_u_runtime/);
  });
});
