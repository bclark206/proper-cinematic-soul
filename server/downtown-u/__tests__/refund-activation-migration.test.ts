import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(
  process.cwd(), "db/migrations/202608040004_downtown_u_refund_activation.sql",
), "utf8");

describe("authoritative refund activation forward migration", () => {
  it("is transactional and exposes one fixed-search-path capability without direct table grants", () => {
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_activate_verified_refund/);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = pg_catalog/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_activate_verified_refund/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.downtown_u_activate_verified_refund/);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL).*downtown_u_refund_(?:applications|reconciliations)/i);
  });

  it("locks both legacy refund-state tables against runtime DML before inspecting them", () => {
    const firstSelect = sql.indexOf("SELECT 1 FROM public.downtown_u_credit_transactions");
    const ledgerLock = sql.indexOf(`LOCK TABLE public.downtown_u_credit_transactions
  IN SHARE ROW EXCLUSIVE MODE`);
    const purchaseLock = sql.indexOf(`LOCK TABLE public.downtown_u_plan_purchases
  IN SHARE ROW EXCLUSIVE MODE`);
    expect(purchaseLock).toBeGreaterThan(sql.indexOf("BEGIN;"));
    expect(ledgerLock).toBeGreaterThan(purchaseLock);
    expect(ledgerLock).toBeLessThan(firstSelect);
  });

  it("stores authoritative economics and explicit cumulative floor policy", () => {
    for (const column of [
      "square_refund_id", "source_event_id", "square_payment_id", "square_order_id",
      "authoritative_amount_cents", "authoritative_currency", "authoritative_location_id",
      "authoritative_updated_at", "cumulative_refunded_cents", "target_refunded_credits",
      "refund_sequence", "credit_delta", "available_credits_before", "status",
    ]) expect(sql).toContain(column);
    expect(sql).toMatch(/cumulative_cents \* purchase\.credits_granted \/ purchase\.price_cents/);
    expect(sql).toMatch(/cumulative_cents = purchase\.price_cents[\s\S]*purchase\.credits_granted/);
    expect(sql).toMatch(/delta_credits := target_credits - purchase\.refunded_credits/);
  });

  it("records insufficient balance without mutating purchase and completes the claim atomically", () => {
    expect(sql).toMatch(/IF delta_credits > available_credits THEN[\s\S]*insufficient_available_credits/);
    expect(sql).toMatch(/ELSE[\s\S]*purchase_refund[\s\S]*UPDATE public\.downtown_u_plan_purchases/);
    expect(sql).toMatch(/UPDATE public\.downtown_u_webhook_events[\s\S]*status='completed'/);
    expect(sql).toMatch(/refund_applications_immutable/);
    expect(sql).toMatch(/refund_reconciliations_immutable/);
    expect(sql).not.toMatch(/payload|raw_json|email|phone/i);
  });

  it("rebuilds duplicate topology from immutable sequence and collision supersets", () => {
    expect(sql).toMatch(/UNIQUE \(purchase_id, refund_sequence\)/);
    expect(sql).toMatch(/refund_sequence<=application\.refund_sequence/);
    expect(sql).toMatch(/status='applied'[\s\S]*prior_applied_credits/);
    expect(sql).toMatch(/available_credits=application\.available_credits_before/);
    expect(sql).toMatch(/q\.available_credits<q\.required_credits/);
    expect(sql).toMatch(/Count the collision superset first/);
    expect(sql).toMatch(/t\.source_id=application\.square_refund_id[\s\S]*t\.idempotency_key='purchase_refund:'/);
  });

  it("mirrors the complete canonical A3b purchase grant signature", () => {
    for (const field of [
      "resulting_balance", "verified Square payment", "purchase_grant:", "square_webhook",
      "square_payment", "locationId",
    ]) expect(sql).toContain(field);
    expect(sql).toMatch(/grant_row\.metadata IS DISTINCT FROM pg_catalog\.jsonb_build_object/);
    expect(sql).toMatch(/t\.ledger_sequence <= grant_row\.ledger_sequence/);
    expect(sql).not.toMatch(/\(t\.created_at,t\.id\) <=/);
  });

  it("adds a locked, unspoofable, student-local immutable ledger sequence", () => {
    expect(sql).toMatch(/ADD COLUMN ledger_sequence BIGINT/);
    expect(sql).toMatch(/ALTER COLUMN ledger_sequence SET NOT NULL/);
    expect(sql).toMatch(/UNIQUE \(student_id,ledger_sequence\)/);
    expect(sql).toMatch(/NEW\.ledger_sequence IS NOT NULL[\s\S]*FOR UPDATE/);
    expect(sql).toMatch(/FOR UPDATE[\s\S]*max\(t\.ledger_sequence\)[\s\S]*INTO NEW\.ledger_sequence/);
    expect(sql).toMatch(/GRANT INSERT \(id,student_id[\s\S]*metadata,created_at\)/);
    expect(sql).not.toMatch(/GRANT INSERT \([^)]*ledger_sequence/);
  });

  it("reconstructs one unique historical balance-transition chain without timestamp or UUID ordering", () => {
    expect(sql).toMatch(/prior_balance := 0/);
    expect(sql).toMatch(/resulting_balance::BIGINT = prior_balance \+ t\.delta::BIGINT/);
    expect(sql).toMatch(/candidate_count <> 1/);
    expect(sql).toMatch(/prior_balance IS DISTINCT FROM student\.credit_balance::BIGINT/);
    expect(sql).toMatch(/ledger_sequence IS NULL[\s\S]*orphan or unassigned/);
    expect(sql).not.toMatch(/row_number\(\)/i);
    expect(sql).not.toMatch(/PARTITION BY t\.student_id ORDER BY t\.created_at/);
  });
});
