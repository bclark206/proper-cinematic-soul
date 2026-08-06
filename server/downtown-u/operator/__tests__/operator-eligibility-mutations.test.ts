import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "202608040012_downtown_u_operator_eligibility_mutations.sql";
const migrationDirectory = resolve(process.cwd(), "db/migrations");
const migrationPath = resolve(migrationDirectory, migrationName);
const signature = "uuid,smallint,bytea,text,text,uuid,uuid,uuid,text,timestamptz,text,text,text";
function migrationSql(): string {
  expect(existsSync(migrationPath), `TDD RED: missing ${migrationName}`).toBe(true);
  return readFileSync(migrationPath, "utf8");
}

describe("operator eligibility mutation migration 012 acceptance contract", () => {
  it("is the unique transactional migration 012", () => {
    expect(readdirSync(migrationDirectory).filter((name) => /^202608040012_.*\.sql$/.test(name))).toEqual([migrationName]);
    const sql = migrationSql();
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("defines exactly one public capability with the pinned signature, return shape and hardening", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_operator_set_eligibility\(\s*requested_session_id uuid,\s*requested_session_version smallint,\s*requested_session_verifier bytea,\s*requested_server_correlation_id text,\s*requested_idempotency_key text,\s*requested_audit_event_id uuid,\s*requested_eligibility_event_id uuid,\s*requested_student_id uuid,\s*requested_expected_status text,\s*requested_expected_updated_at timestamptz,\s*requested_decision text,\s*requested_reason_code text,\s*requested_reason text\s*\)/s);
    expect(sql).toMatch(/RETURNS TABLE\(outcome text,replayed boolean,item jsonb\)[\s\S]*?LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog/);
    expect(sql.match(/CREATE FUNCTION public\.downtown_u_operator_set_eligibility\(/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CREATE FUNCTION public\.downtown_u_operator_(?!set_eligibility)/);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.downtown_u_operator_set_eligibility(${signature}) TO downtown_u_operator_runtime`);
  });

  it("pins strict canonical inputs, decisions, reasons and every legal edge", () => {
    const sql = migrationSql();
    expect(sql).toContain("opm:v1:");
    expect(sql).toContain("^opm:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    expect(sql).toContain("^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$");
    for (const token of ["approve", "reject", "suspend", "reinstate", "documentation_verified", "documentation_incomplete", "policy_ineligible", "safety_hold", "policy_hold", "hold_cleared"]) expect(sql).toContain(`'${token}'`);
    for (const edge of [["pending", "approved"], ["pending", "rejected"], ["approved", "suspended"], ["suspended", "approved"]]) {
      expect(sql).toMatch(new RegExp(`'${edge[0]}'[\\s\\S]{0,220}'${edge[1]}'`));
    }
    expect(sql).toMatch(/requested_reason=pg_catalog\.normalize\(requested_reason,'NFC'\)/);
    expect(sql).toMatch(/requested_reason=pg_catalog\.btrim\(requested_reason\)/);
    expect(sql).toMatch(/length\(requested_reason\).*BETWEEN 1 AND 500/s);
    expect(sql).toMatch(/requested_reason.*!~.*cntrl/s);
  });

  it("authorizes and locks in the required order before the shared idempotency lock and student lock", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/downtown_u_operator_sessions[\s\S]*FOR UPDATE[\s\S]*downtown_u_operator_accounts[\s\S]*FOR (?:SHARE|UPDATE)[\s\S]*downtown_u_operator_config[\s\S]*FOR (?:SHARE|UPDATE)[\s\S]*downtown_u_operator_account_roles[\s\S]*ORDER BY r\.role_code,r\.id FOR SHARE[\s\S]*pg_advisory_xact_lock[\s\S]*downtown_u_students[\s\S]*FOR UPDATE/);
    expect(sql).toContain("eligibility_reviewer");
    expect(sql).toMatch(/read_enabled[\s\S]*mutations_enabled/);
    expect(sql).toMatch(/purpose='reauth'[\s\S]*factor='sms_otp'[\s\S]*status='consumed'/);
    expect(sql).toMatch(/consumed_at>now_at-INTERVAL '5 minutes'/);
    expect(sql).toMatch(/consumed_at<=now_at/);
    expect(sql).toMatch(/idle_expires_at<=now_at OR session_row\.absolute_expires_at<=now_at/);
    expect(sql).toMatch(/last_seen_at=now_at[\s\S]*idle_expires_at=LEAST\(now_at\+INTERVAL '30 minutes'/);
  });

  it("makes global audit idempotency authoritative and exact without repairing evidence", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/downtown_u_operator_audit_events[\s\S]*idempotency_key=requested_idempotency_key/);
    expect(sql).toMatch(/idempotency_conflict/);
    for (const field of ["operator_id", "action_code", "target_type", "target_id", "reason_code", "reason"]) expect(sql).toContain(field);
    expect(sql).toMatch(/downtown_u_eligibility_events[\s\S]*audit_event_id/);
    expect(sql).toMatch(/downtown_u_operator_reconciliation_cases[\s\S]*audit_event_id/);
    expect(sql).toMatch(/downtown_u_operator_reconciliation_resolutions[\s\S]*audit_event_id/);
    expect(sql).toMatch(/downtown_u_operator_adjustments[\s\S]*audit_event_id/);
    expect(sql).toMatch(/from_status[\s\S]*to_status/);
    expect(sql).not.toMatch(/ON CONFLICT[\s\S]{0,180}(?:audit_events|eligibility_events)/i);
  });

  it("writes one-now atomic evidence with application IDs and returns only the redacted allowlist", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/now_at TIMESTAMPTZ := pg_catalog\.clock_timestamp\(\)/);
    expect(sql).toMatch(/INSERT INTO public\.downtown_u_operator_audit_events/);
    expect(sql).toMatch(/INSERT INTO public\.downtown_u_eligibility_events/);
    expect(sql).toContain("ALTER TABLE public.downtown_u_eligibility_events ADD COLUMN result_item JSONB");
    expect(sql).toContain("downtown_u_eligibility_events_result_item_shape_check");
    expect(sql).toMatch(/ADD CONSTRAINT downtown_u_eligibility_events_result_item_not_null_check CHECK \(result_item IS NOT NULL\) NOT VALID/);
    expect(sql).toMatch(/created_at,result_item\)[\s\S]*now_at,result_item\)/);
    expect(sql).toMatch(/result_item := event_row\.result_item/);
    expect(sql).toMatch(/requested_audit_event_id/);
    expect(sql).toMatch(/requested_eligibility_event_id/);
    expect(sql).toMatch(/set_config\('downtown_u\.operator_write',pg_catalog\.pg_backend_pid\(\)::TEXT\|\|':'\|\|pg_catalog\.pg_current_xact_id\(\)::TEXT,true\)/);
    for (const action of ["eligibility_approve", "eligibility_reject", "eligibility_suspend", "eligibility_reinstate"]) expect(sql).toContain(`'${action}'`);
    for (const key of ["studentId", "eligibilityStatus", "eligibilityReviewedAt", "approvedAt", "rejectedAt", "suspendedAt", "updatedAt"]) expect(sql).toContain(`'${key}'`);
    for (const forbidden of ["normalizedEmail", "normalizedPhone", "squareCustomerId", "creditBalance", "operatorId", "sessionId", "auditEventId", "reason", "reasonCode"]) expect(sql).not.toContain(`'${forbidden}'`);
    expect(sql).not.toMatch(/INSERT INTO public\.downtown_u_(?:credit_transactions|plan_purchases|redemptions|refund|kitchen)/);
  });

  it("normalizes hostile ACLs and exposes exactly twelve non-grantable runtime capabilities", () => {
    const sql = migrationSql();
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM downtown_u_operator_runtime");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM downtown_u_operator_runtime");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM downtown_u_operator_runtime");
    expect(sql).toMatch(/<>12/);
    expect(sql).toMatch(/is_grantable/);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|USAGE) ON (?:TABLE|SEQUENCE)/i);
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]* TO (?:PUBLIC|downtown_u_runtime|downtown_u_jobs|downtown_u_kitchen_jobs)/i);
    const capabilityBody = sql.slice(0, sql.indexOf("/* Re-normalize ambient defaults"));
    expect(capabilityBody).not.toMatch(/\bEXECUTE\b|format\s*\(/i);
  });
});
