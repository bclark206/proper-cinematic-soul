import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "db/migrations/202608040001_downtown_u_phase1.sql");
const sql = readFileSync(migrationPath, "utf8");

describe("Downtown U Phase 1 migration", () => {
  it("defines constrained UUID entities and canonical plan economics", () => {
    expect(sql).toMatch(/CREATE TABLE public\.downtown_u_students/i);
    expect(sql).toMatch(/CREATE TABLE public\.downtown_u_plan_purchases/i);
    expect(sql).toMatch(/CREATE TABLE public\.downtown_u_credit_transactions/i);
    expect(sql).toMatch(/CREATE TABLE public\.downtown_u_redemptions/i);
    expect(sql).toContain("gen_random_uuid()");
    for (const tuple of ["('flex-5', 5, 6000)", "('scholar-10', 10, 11000)", "('resident-20', 20, 21000)", "('semester-40', 40, 40000)"]) expect(sql).toContain(tuple);
    expect(sql).toMatch(/REFERENCES public\.downtown_u_students\(id\) ON DELETE RESTRICT/i);
    expect(sql).toMatch(/REFERENCES public\.downtown_u_plans\(id\) ON DELETE RESTRICT/i);
    expect(sql).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  });

  it("constrains normalized identity, eligibility, and operational states", () => {
    expect(sql).toMatch(/normalized_email = lower\(btrim\(normalized_email\)\)/i);
    expect(sql).toContain("normalized_phone ~ '^[+][1-9][0-9]{7,14}$'");
    for (const status of ["pending", "approved", "rejected", "suspended"]) expect(sql).toContain(`'${status}'`);
    expect(sql).toMatch(/status IN \('paid', 'partially_refunded', 'refunded'\)/i);
    expect(sql).toMatch(/status IN \('reserved', 'redeemed', 'reversed', 'cancelled'\)/i);
    expect(sql).toMatch(/refunded_credits >= 0 AND refunded_credits <= credits_granted/i);
  });

  it("has source uniqueness, non-negative balance, and append-only enforcement", () => {
    expect(sql).toMatch(/square_payment_id TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/square_order_id TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/source_event_id TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/idempotency_key TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/credit_balance INTEGER NOT NULL DEFAULT 0 CHECK \(credit_balance >= 0\)/i);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.downtown_u_credit_transactions/i);
    expect(sql).toMatch(/BEFORE TRUNCATE ON public\.downtown_u_credit_transactions/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'downtown_u_credit_transactions is append-only'/i);
    expect(sql).toMatch(/canonical plan economics are immutable/i);
    expect(sql).toMatch(/balance may only change through the credit ledger/i);
  });

  it("serializes balance changes at the database and rejects negative results", () => {
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/IF NEW\.resulting_balance <> current_balance \+ NEW\.delta/i);
    expect(sql).toMatch(/IF NEW\.resulting_balance < 0/i);
  });

  it("separates migration ownership from the least-privilege runtime role", () => {
    expect(sql).not.toMatch(/CREATE EXTENSION/i);
    expect(sql).toMatch(/CREATE ROLE downtown_u_runtime NOLOGIN/i);
    expect(sql).toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_apply_credit_transaction\(\) FROM PUBLIC/i);
    expect(sql).toMatch(/GRANT (?:SELECT|INSERT)[\s\S]* TO downtown_u_runtime/i);
    expect(sql).toMatch(/SET search_path = pg_catalog/i);
    expect(sql).not.toMatch(/GRANT SELECT, INSERT ON public\.downtown_u_students/i);
    expect(sql).toMatch(/GRANT INSERT \(normalized_email, normalized_phone, square_customer_id\)\s+ON public\.downtown_u_students TO downtown_u_runtime/i);
  });

  it("defines semantic validation, immutability guards, and lookup indexes", () => {
    expect(sql).not.toContain("manual_adjustment");
    expect(sql).toMatch(/purchase_grant[\s\S]*credits_granted/i);
    expect(sql).toMatch(/reservation[\s\S]*credits/i);
    expect(sql).toMatch(/redemption_reversal[\s\S]*credits/i);
    expect(sql).toMatch(/redemption reversal requires exactly one reservation ledger entry/i);
    expect(sql).toMatch(/purchase refund credits exceed the purchase grant/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX downtown_u_credit_transactions_one_purchase_grant/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX downtown_u_credit_transactions_one_reservation/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX downtown_u_credit_transactions_one_reversal/i);
    expect(sql).toMatch(/\(purchase_id, transaction_type\)/i);
    expect(sql).toMatch(/\(redemption_id, transaction_type\)/i);
    expect(sql).toMatch(/purchase economics and ownership are immutable/i);
    expect(sql).toMatch(/redemption economics and ownership are immutable/i);
  });
});
