import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const name = "202608040010_downtown_u_operator_auth_capabilities.sql";
const directory = resolve(process.cwd(), "db/migrations");
const sql = readFileSync(resolve(directory, name), "utf8");

const signatures = [
  "downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text)",
  "downtown_u_operator_auth_verify_email(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)",
  "downtown_u_operator_auth_finish_sign_in(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)",
  "downtown_u_operator_auth_validate_session(uuid,smallint,bytea,text,text,text)",
  "downtown_u_operator_auth_begin_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)",
  "downtown_u_operator_auth_finish_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)",
  "downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text)",
];

describe("operator authentication capability migration 010", () => {
  it("is the unique transactional migration 010", () => {
    expect(readdirSync(directory).filter((entry) => /^202608040010_.*\.sql$/.test(entry))).toEqual([name]);
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("defines exactly the seven C1+C2 entry points as hardened security definers", () => {
    for (const functionName of ["downtown_u_operator_auth_begin", "downtown_u_operator_auth_verify_email", "downtown_u_operator_auth_finish_sign_in", "downtown_u_operator_auth_validate_session", "downtown_u_operator_auth_begin_reauth", "downtown_u_operator_auth_finish_reauth", "downtown_u_operator_auth_revoke_session"]) {
      expect(sql).toMatch(new RegExp(`CREATE FUNCTION public\\.${functionName}\\([\\s\\S]*?LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog`));
    }
    expect(sql.match(/CREATE FUNCTION public\.downtown_u_operator_auth_/g)).toHaveLength(7);
  });

  it("uses fixed policies, application-provided opaque IDs and 32-byte version-one verifiers", () => {
    expect(sql).toContain("INTERVAL '15 minutes'");
    expect(sql).toContain("INTERVAL '10 minutes'");
    expect(sql).toContain("INTERVAL '5 minutes'");
    expect(sql).toContain("INTERVAL '8 hours'");
    expect(sql).toContain("INTERVAL '30 minutes'");
    expect(sql).toMatch(/requested_version<>1[\s\S]*octet_length\(requested_flow_verifier\)<>32/);
    expect(sql).toMatch(/requested_email_challenge_id[\s\S]*requested_sms_challenge_id[\s\S]*requested_session_id/);
    expect(sql).not.toMatch(/digest\s*\(|hmac\s*\(|gen_random_uuid\(\)/i);
  });

  it("locks in account-flow-ordered-challenge order and asserts every mutation row count", () => {
    expect(sql).toMatch(/SELECT f\.operator_id[\s\S]*downtown_u_operator_accounts[\s\S]*FOR UPDATE[\s\S]*WHERE f\.id=requested_flow_id AND f\.operator_id=lookup_operator_id FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY c\.id FOR UPDATE/);
    expect(sql).toContain("GET DIAGNOSTICS affected_rows = ROW_COUNT");
    expect(sql).toContain("unexpected row count");
  });

  it("implements generic enumeration resistance, rate limits, revocation and bounded attempts", () => {
    expect(sql).toMatch(/normalized_email=requested_normalized_email/);
    expect(sql).toMatch(/INTERVAL '1 minute'/);
    expect(sql).toMatch(/INTERVAL '1 hour'[\s\S]*>=5/);
    expect(sql).toMatch(/attempt_count<5/);
    expect(sql).toMatch(/attempt_count\+1/);
    expect(sql).toMatch(/status='revoked'/);
    expect(sql).not.toMatch(/RETURN[\s\S]{0,100}normalized_email/);
  });

  it("requires and consumes both factors before atomically minting one bounded session", () => {
    expect(sql).toMatch(/status='consumed'[\s\S]*factor='email_magic_link'/);
    expect(sql).toMatch(/status='pending'[\s\S]*factor='sms_otp'/);
    expect(sql).toMatch(/status='complete'[\s\S]*status='consumed'/);
    expect(sql).toMatch(/INSERT INTO public\.downtown_u_operator_sessions/);
    expect(sql).toMatch(/INTERVAL '8 hours'[\s\S]*absolute_expires_at/);
    expect(sql).toMatch(/INTERVAL '30 minutes'[\s\S]*idle_expires_at/);
    expect(sql).not.toMatch(/EXCEPTION\s+WHEN\s+unique_violation/i);
  });

  it("writes only bounded evidence while preserving the caller's prior GUC around each append", () => {
    expect(sql).toContain("current_setting('downtown_u.operator_write',true)");
    expect(sql).toContain("pg_catalog.set_config('downtown_u.operator_write'");
    expect(sql).toMatch(/INSERT INTO public\.downtown_u_operator_security_events/g);
    expect(sql).not.toMatch(/json|requested_normalized_email[^\n]*security_events|requested_.*verifier[^\n]*security_events/i);
  });

  it("fixes session authorization, rolling expiry, role/gate matrix and five-minute reauth policy", () => {
    expect(sql).toMatch(/requested_gate_code NOT IN \('read','mutations','exports'\)/);
    expect(sql).toMatch(/latest_reauth>now_at-INTERVAL '5 minutes'/);
    expect(sql).toMatch(/LEAST\(now_at\+INTERVAL '30 minutes',session_row\.absolute_expires_at\)/);
    expect(sql).toMatch(/idle_expires_at<=now_at OR session_row\.absolute_expires_at<=now_at/);
  });

  it("binds reauth SMS to one session, rate limits it, bounds attempts and revokes it on logout", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX downtown_u_operator_reauth_one_pending_per_session");
    expect(sql).toContain("CREATE INDEX downtown_u_operator_reauth_rate_idx");
    expect(sql).toMatch(/attempt_count\+1>=5/);
    expect(sql).toMatch(/purpose='reauth'[\s\S]*factor='sms_otp'/);
  });

  it("normalizes hostile ACLs and exposes only the exact seven non-grantable signatures", () => {
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO downtown_u_operator_runtime");
    expect(sql).not.toContain("GRANT CREATE ON SCHEMA public TO downtown_u_operator_runtime");
    expect(sql).toContain("pg_catalog.aclexplode");
    for (const signature of signatures) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO downtown_u_operator_runtime`);
    }
    expect(sql).toMatch(/non-owner operator relation ACL remains/);
    expect(sql).toMatch(/operator function ACL is not exact/);
    expect(sql).toMatch(/is_grantable/);
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]* TO (?:PUBLIC|downtown_u_runtime|downtown_u_jobs|downtown_u_kitchen_jobs)/i);
  });
});
