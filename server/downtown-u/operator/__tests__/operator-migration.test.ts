import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "202608040009_downtown_u_operator_audit.sql";
const migrationsDirectory = resolve(process.cwd(), "db/migrations");
const sql = readFileSync(resolve(migrationsDirectory, migrationName), "utf8");

const tableDefinition = (table: string) => {
  const match = sql.match(new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `${table} must have a CREATE TABLE definition`).not.toBeNull();
  return match![1];
};

describe("operator schema migration", () => {
  it("has a unique migration number and a transactional, least-privilege capability role", () => {
    const migration009 = readdirSync(migrationsDirectory).filter((name) => /^202608040009_.*\.sql$/.test(name));
    expect(migration009).toEqual([migrationName]);
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("CREATE ROLE downtown_u_operator_runtime NOLOGIN");
    expect(sql).toContain("Existing downtown_u_operator_runtime role is unsafe");
    expect(sql).toMatch(/rolcanlogin[\s\S]*rolsuper[\s\S]*rolcreatedb[\s\S]*rolcreaterole[\s\S]*rolreplication[\s\S]*rolbypassrls/);
    expect(sql).toContain("REVOKE ALL ON SCHEMA public FROM downtown_u_operator_runtime");
    expect(sql).not.toMatch(/GRANT (?:USAGE|CREATE) ON SCHEMA .*downtown_u_operator_runtime/i);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL).*downtown_u_operator_runtime/i);
    expect(sql).not.toMatch(/GRANT EXECUTE .*downtown_u_operator_runtime/i);
    expect(sql).not.toMatch(/CREATE\s+(?:USER|ROLE)[^;]*\bLOGIN\b/i);
  });

  it("creates owner-only default-off feature gates and passwordless provisioned accounts", () => {
    const config = tableDefinition("downtown_u_operator_config");
    for (const gate of ["read_enabled", "mutations_enabled", "exports_enabled"]) {
      expect(config).toMatch(new RegExp(`${gate} BOOLEAN NOT NULL DEFAULT false`));
    }
    expect(config).toMatch(/singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
    expect(sql).toContain("INSERT INTO public.downtown_u_operator_config(singleton) VALUES(true)");

    const accounts = tableDefinition("downtown_u_operator_accounts");
    expect(accounts).toMatch(/id UUID PRIMARY KEY DEFAULT pg_catalog\.gen_random_uuid\(\)/);
    expect(accounts).toMatch(/normalized_email TEXT NOT NULL UNIQUE/);
    expect(accounts).toMatch(/normalized_phone TEXT NOT NULL UNIQUE/);
    expect(accounts).toMatch(/normalized_email=pg_catalog\.lower\(pg_catalog\.btrim\(normalized_email\)\)/);
    expect(accounts).toMatch(/normalized_phone ~ '\^\[\+\]\[1-9\]\[0-9\]\{7,14\}\$'/);
    expect(accounts).toMatch(/display_name TEXT NOT NULL[\s\S]*BETWEEN 1 AND 120/);
    expect(accounts).toMatch(/status TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active','disabled'\)\)/);
    expect(accounts).toMatch(/provisioning_reference TEXT NOT NULL UNIQUE[\s\S]*\{0,127\}/);
    for (const timestamp of ["created_at", "updated_at", "disabled_at"]) expect(accounts).toContain(timestamp);
    expect(accounts).toMatch(/\(status='active' AND disabled_at IS NULL\)[\s\S]*\(status='disabled' AND disabled_at IS NOT NULL\)/);
    expect(accounts).not.toMatch(/pass(word)?|secret|hash|credential/i);
  });

  it("models fixed, currently re-checkable owner-provisioned RBAC assignments", () => {
    const roles = tableDefinition("downtown_u_operator_account_roles");
    for (const role of ["eligibility_reviewer", "reconciliation_operator", "credit_adjuster", "audit_exporter"]) {
      expect(roles).toContain(`'${role}'`);
    }
    expect(roles).toMatch(/account_id UUID NOT NULL REFERENCES public\.downtown_u_operator_accounts\(id\) ON DELETE RESTRICT/);
    expect(roles).toMatch(/assigned_by_operator_id UUID REFERENCES public\.downtown_u_operator_accounts\(id\) ON DELETE RESTRICT/);
    expect(roles).toContain("assigned_by_reference");
    expect(roles).toContain("revoked_by_operator_id");
    expect(roles).toContain("revocation_reference");
    expect(roles).toContain("revoked_at");
    expect(sql).toMatch(/CREATE UNIQUE INDEX downtown_u_operator_account_roles_active_key[\s\S]*WHERE revoked_at IS NULL/);
    expect(sql).not.toMatch(/GRANT .*downtown_u_operator_(?:accounts|account_roles)/i);
  });

  it("models fixation-resistant email-link plus SMS flows, bound reauth, and bounded sessions", () => {
    const flows = tableDefinition("downtown_u_operator_auth_flows");
    const challenges = tableDefinition("downtown_u_operator_auth_challenges");
    expect(flows).toMatch(/flow_verifier BYTEA NOT NULL[\s\S]*octet_length\(flow_verifier\)=32/);
    expect(flows).toContain("'pending_email','pending_sms','complete','consumed','expired','revoked'");
    expect(flows).toMatch(/UNIQUE \(id,operator_id\)/);
    expect(challenges).toMatch(/verifier_version SMALLINT NOT NULL DEFAULT 1 CHECK \(verifier_version=1\)/);
    expect(challenges).toMatch(/challenge_verifier BYTEA NOT NULL[\s\S]*octet_length\(challenge_verifier\)=32/);
    expect(challenges).toMatch(/purpose TEXT NOT NULL CHECK \(purpose IN \('sign_in','reauth'\)\)/);
    expect(challenges).toMatch(/factor TEXT NOT NULL CHECK \(factor IN \('email_magic_link','sms_otp'\)\)/);
    expect(challenges).toMatch(/purpose='sign_in'[\s\S]*flow_id IS NOT NULL[\s\S]*session_id IS NULL/);
    expect(challenges).toMatch(/purpose='reauth'[\s\S]*factor='sms_otp'[\s\S]*flow_id IS NULL[\s\S]*session_id IS NOT NULL/);
    expect(challenges).toMatch(/status TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending','verified','consumed','expired','revoked'\)\)/);
    expect(challenges).toMatch(/attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK \(attempt_count BETWEEN 0 AND 10\)/);
    expect(challenges).toContain("expires_at");
    expect(challenges).toContain("revoked_at");

    const sessions = tableDefinition("downtown_u_operator_sessions");
    expect(sessions).toMatch(/session_verifier BYTEA NOT NULL[\s\S]*octet_length\(session_verifier\)=32/);
    expect(sessions).toMatch(/consumed_auth_flow_id UUID NOT NULL UNIQUE/);
    expect(sessions).toMatch(/consumed_flow_status TEXT NOT NULL DEFAULT 'consumed' CHECK \(consumed_flow_status='consumed'\)/);
    expect(sessions).toMatch(/status TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active','expired','revoked'\)\)/);
    for (const column of ["absolute_expires_at", "idle_expires_at", "last_seen_at"]) expect(sessions).toContain(column);
    expect(sessions).toMatch(/created_at<=last_seen_at AND last_seen_at<=updated_at/);
    expect(sessions).toMatch(/idle_expires_at>last_seen_at AND idle_expires_at<=last_seen_at\+INTERVAL '30 minutes' AND idle_expires_at<=absolute_expires_at/);
    expect(sessions).toMatch(/absolute_expires_at<=created_at\+INTERVAL '8 hours'/);
    expect(sessions).not.toMatch(/idle_expires_at<=created_at\+INTERVAL '30 minutes'/);
    expect(sessions).toContain("revoked_at");
    expect(sessions).toMatch(/UNIQUE \(id,operator_id\)/);
    expect(sql).toMatch(/CREATE INDEX downtown_u_operator_auth_challenges_digest_idx/);
    expect(sql).toMatch(/CREATE INDEX downtown_u_operator_auth_challenges_expiry_idx/);
    expect(sql).toMatch(/CREATE INDEX downtown_u_operator_sessions_digest_idx/);
    expect(sql).toMatch(/CREATE INDEX downtown_u_operator_sessions_expiry_idx/);
    expect(`${flows}\n${challenges}\n${sessions}`).not.toMatch(/raw_|token|otp_value|password|secret|email TEXT|phone TEXT|pre_mfa|recent_reauth_at|assurance_level/i);
    expect(sql).toMatch(/HMAC-SHA256[\s\S]*external secret[\s\S]*record ID[\s\S]*purpose[\s\S]*factor/i);
    expect(sql).toMatch(/both sign-in challenges[\s\S]*SECURITY DEFINER[\s\S]*3\.1C/i);
  });

  it("freezes provisioned contacts and records bounded append-only pre-auth and owner events", () => {
    expect(sql).toContain("downtown_u_operator_accounts_immutable_identity_guard");
    expect(sql).toMatch(/normalized_email IS DISTINCT FROM OLD\.normalized_email[\s\S]*normalized_phone IS DISTINCT FROM OLD\.normalized_phone[\s\S]*provisioning_reference IS DISTINCT FROM OLD\.provisioning_reference/);
    for (const table of ["downtown_u_operator_security_events", "downtown_u_operator_owner_events"]) {
      const definition = tableDefinition(table);
      expect(definition).not.toMatch(/JSON|raw_|token|normalized_email|normalized_phone/i);
      expect(sql).toContain(`BEFORE INSERT OR UPDATE OR DELETE ON public.${table}`);
      expect(sql).toContain(`BEFORE TRUNCATE ON public.${table}`);
    }
  });

  it("defines bounded append-only audit and eligibility mutation evidence", () => {
    const audit = tableDefinition("downtown_u_operator_audit_events");
    const eligibility = tableDefinition("downtown_u_eligibility_events");
    for (const column of ["operator_id", "session_id", "action_code", "target_type", "target_id", "reason_code", "reason", "idempotency_key", "correlation_id", "created_at"]) {
      expect(audit).toContain(column);
    }
    for (const column of ["operator_id", "session_id", "student_id", "from_status", "to_status", "reason_code", "reason", "idempotency_key", "correlation_id", "created_at"]) {
      expect(eligibility).toContain(column);
    }
    expect(audit).not.toMatch(/JSON|private_notes/i);
    expect(eligibility).not.toMatch(/JSON|private_notes/i);
    expect(audit).toMatch(/UNIQUE \(idempotency_key\)/);
    expect(audit).toMatch(/UNIQUE \(id,operator_id,session_id,correlation_id\)/);
    expect(eligibility).toMatch(/UNIQUE \(idempotency_key\)/);
    expect(eligibility).toMatch(/audit_event_id UUID NOT NULL/);
    expect(eligibility).toMatch(/FOREIGN KEY \(audit_event_id,operator_id,session_id,correlation_id\)/);
  });

  it("derives reconciliation state from one immutable resolution and idempotently imports both authorities", () => {
    const cases = tableDefinition("downtown_u_operator_reconciliation_cases");
    const resolutions = tableDefinition("downtown_u_operator_reconciliation_resolutions");
    expect(cases).toMatch(/source_type TEXT NOT NULL CHECK \(source_type IN \('refund','kitchen'\)\)/);
    expect(cases).toMatch(/UNIQUE \(source_type,source_id\)/);
    expect(cases).toMatch(/correlation_id TEXT NOT NULL/);
    expect(cases).toMatch(/audit_event_id UUID/);
    expect(cases).toMatch(/origin IN \('migration_backfill','source_sync','operator'\)/);
    expect(cases).toMatch(/origin='operator'[\s\S]*audit_event_id IS NOT NULL/);
    expect(cases).not.toMatch(/\bstatus\b|\bstate\b|resolved_at/i);
    expect(resolutions).toMatch(/case_id UUID NOT NULL UNIQUE REFERENCES public\.downtown_u_operator_reconciliation_cases\(id\) ON DELETE RESTRICT/);
    expect(resolutions).toMatch(/correlation_id TEXT NOT NULL/);
    expect(resolutions).toMatch(/audit_event_id UUID NOT NULL/);
    expect(sql).toMatch(/CREATE VIEW public\.downtown_u_operator_reconciliation_case_state[\s\S]*EXISTS[\s\S]*downtown_u_operator_reconciliation_resolutions/);
    expect(sql).toMatch(/FROM public\.downtown_u_refund_reconciliations AS q/);
    expect(sql).toMatch(/FROM public\.downtown_u_kitchen_order_outbox AS o[\s\S]*o\.state='operator_review'/);
    expect(sql).toMatch(/ON CONFLICT \(source_type,source_id\) DO NOTHING/g);
    expect(sql.match(/ON CONFLICT \(source_type,source_id\) DO NOTHING/g)).toHaveLength(2);
    expect(sql).toContain("q.id::TEXT");
    expect(sql).toContain("o.redemption_id::TEXT");
    expect(sql).not.toMatch(/UPDATE public\.downtown_u_refund_reconciliations/i);
    expect(sql).not.toMatch(/UPDATE public\.downtown_u_kitchen_order_outbox/i);
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_operator_sync_refund_case\(\) RETURNS trigger[\s\S]*SECURITY DEFINER SET search_path=pg_catalog/);
    expect(sql).toMatch(/AFTER INSERT ON public\.downtown_u_refund_reconciliations/);
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_operator_sync_kitchen_case\(\) RETURNS trigger[\s\S]*SECURITY DEFINER SET search_path=pg_catalog/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF state ON public\.downtown_u_kitchen_order_outbox/);
    expect(sql).toMatch(/NEW\.state='operator_review'[\s\S]*OLD\.state IS DISTINCT FROM 'operator_review'/);
    expect(sql).toContain("'kitchen_operator_review'");
  });

  it("adds immutable signed adjustments without weakening legacy ledger topology", () => {
    const adjustments = tableDefinition("downtown_u_operator_adjustments");
    for (const column of ["operator_id", "session_id", "student_id", "delta", "reason_code", "reason", "idempotency_key", "target_type", "target_id", "created_at"]) {
      expect(adjustments).toContain(column);
    }
    expect(adjustments).toMatch(/delta INTEGER NOT NULL CHECK \(delta BETWEEN -40 AND 40 AND delta<>0\)/);
    expect(adjustments).toMatch(/UNIQUE \(idempotency_key\)/);
    expect(adjustments).toMatch(/correlation_id TEXT NOT NULL/);
    expect(adjustments).toMatch(/audit_event_id UUID NOT NULL/);
    expect(adjustments).toMatch(/UNIQUE \(id,student_id\)/);
    expect(sql).toContain("ADD COLUMN operator_adjustment_id UUID");
    expect(sql).not.toMatch(/DROP CONSTRAINT downtown_u_credit_transactions_(?:delta|resulting_balance)_check/);
    expect(sql).toContain("'purchase_grant','purchase_refund','reservation','redemption_reversal','operator_adjustment'");
    expect(sql).toContain("'student','square_webhook','order_service','system','operator'");
    expect(sql).toMatch(/transaction_type IN \('purchase_grant','redemption_reversal'\) AND delta>0/);
    expect(sql).toMatch(/transaction_type IN \('purchase_refund','reservation'\) AND delta<0/);
    expect(sql).toMatch(/\(transaction_type IN \('purchase_grant','purchase_refund'\)\)=\(purchase_id IS NOT NULL\)/);
    expect(sql).toMatch(/\(transaction_type IN \('reservation','redemption_reversal'\)\)=\(redemption_id IS NOT NULL\)/);
    expect(sql).toMatch(/\(transaction_type='operator_adjustment'\)=\(operator_adjustment_id IS NOT NULL\)/);
    expect(sql).toMatch(/\(transaction_type='operator_adjustment'\)=\(actor_type='operator'\)/);
    expect(sql).toMatch(/FOREIGN KEY \(operator_adjustment_id,student_id\)[\s\S]*REFERENCES public\.downtown_u_operator_adjustments\(id,student_id\)/);
    expect(sql).toMatch(/operator_adjustment[\s\S]*future capability[\s\S]*atomically/i);
    expect(sql).not.toMatch(/GRANT .*operator_adjustment/i);
  });

  it("hardens all append-only records and grants no hidden access", () => {
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_operator_append_only_guard\(\) RETURNS trigger[\s\S]*SECURITY DEFINER SET search_path=pg_catalog/);
    expect(sql).toContain("current_setting('downtown_u.operator_write',true)");
    for (const table of [
      "downtown_u_operator_audit_events",
      "downtown_u_eligibility_events",
      "downtown_u_operator_reconciliation_cases",
      "downtown_u_operator_reconciliation_resolutions",
      "downtown_u_operator_adjustments",
      "downtown_u_operator_security_events",
      "downtown_u_operator_owner_events",
    ]) {
      expect(sql).toContain(`BEFORE INSERT OR UPDATE OR DELETE ON public.${table}`);
      expect(sql).toContain(`BEFORE TRUNCATE ON public.${table}`);
    }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.downtown_u_operator_append_only_guard\(\) FROM PUBLIC/);
    expect(sql).not.toMatch(/GRANT EXECUTE .*PUBLIC/i);
    expect(sql).not.toMatch(/GRANT .* TO (?:PUBLIC|downtown_u_runtime|downtown_u_jobs|downtown_u_kitchen_jobs)/i);
    expect(sql).toMatch(/REVOKE ALL ON public\.downtown_u_operator_config,[\s\S]*FROM PUBLIC,downtown_u_operator_runtime,downtown_u_runtime,downtown_u_jobs,downtown_u_kitchen_jobs/);
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain("pg_catalog.format");
    expect(sql).toMatch(/non-owner operator relation ACL remains/);
    expect(sql).toMatch(/non-owner operator function ACL remains/);
  });
});
