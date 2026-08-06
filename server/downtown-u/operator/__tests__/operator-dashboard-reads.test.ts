import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const name="202608040011_downtown_u_operator_dashboard_reads.sql";
const directory=resolve(process.cwd(),"db/migrations");
const sql=readFileSync(resolve(directory,name),"utf8");
const reads=["students","purchases","redemptions","reconciliation"];

describe("operator dashboard read migration 011",()=>{
  it("is the unique transactional migration 011",()=>{
    expect(readdirSync(directory).filter(x=>/^202608040011_.*\.sql$/.test(x))).toEqual([name]);
    expect(sql).toMatch(/^BEGIN;/); expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });
  it("defines four public hardened list capabilities and one private principal helper",()=>{
    for(const read of reads) expect(sql).toMatch(new RegExp(`CREATE FUNCTION public\\.downtown_u_operator_read_${read}\\([\\s\\S]*?RETURNS TABLE\\(outcome text,items jsonb\\)[\\s\\S]*?SECURITY DEFINER SET search_path=pg_catalog`));
    expect(sql.match(/CREATE FUNCTION public\.downtown_u_operator_read_(?:students|purchases|redemptions|reconciliation)\(/g)).toHaveLength(4);
    expect(sql).toMatch(/CREATE FUNCTION public\.downtown_u_operator_read_principal\([\s\S]*?SECURITY DEFINER SET search_path=pg_catalog/);
  });
  it("revalidates and locks session-account-config-ordered roles in the helper",()=>{
    expect(sql).toMatch(/downtown_u_operator_sessions[\s\S]*FOR UPDATE[\s\S]*downtown_u_operator_accounts[\s\S]*FOR SHARE[\s\S]*downtown_u_operator_config[\s\S]*FOR SHARE[\s\S]*ORDER BY r\.role_code,r\.id FOR SHARE/);
    expect(sql).not.toMatch(/downtown_u_operator_(?:accounts|config)[\s\S]{0,160}FOR UPDATE/);
    expect(sql).toMatch(/octet_length\(requested_session_verifier\)=32/);
    expect(sql).toMatch(/idle_expires_at<=now_at OR session_row\.absolute_expires_at<=now_at/);
    expect(sql).toMatch(/read_enabled/); expect(sql).toMatch(/revoked_at IS NULL/);
  });
  it("encodes the fixed least-privilege role and scope matrix without reauth",()=>{
    expect(sql).toContain("eligibility_reviewer"); expect(sql).toContain("reconciliation_operator"); expect(sql).toContain("credit_adjuster");
    expect(sql).toContain("students_global"); expect(sql).toContain("students_exact");
    expect(sql).toContain("purchases_global"); expect(sql).toContain("purchases_exact");
    expect(sql).toContain("redemptions_global"); expect(sql).toContain("redemptions_exact");
    expect(sql).toContain("reconciliation_list"); expect(sql).not.toContain("latest_reauth");
  });
  it("uses paired nullable cursors, bounded limits, fixed filters and static positional predicates",()=>{
    expect(sql).toMatch(/requested_limit NOT BETWEEN 1 AND 101/g);
    expect(sql).toMatch(/\(cursor_created_at IS NULL\)<>\(cursor_id IS NULL\)/g);
    expect(sql).toMatch(/\([a-z]\.created_at,[a-z]\.id\)<\(cursor_created_at,cursor_id\)/g);
    expect(sql).toMatch(/ORDER BY [a-z]\.created_at DESC,[a-z]\.id DESC/g);
    const capabilityBodies=sql.slice(0,sql.indexOf("/* Re-normalize ambient defaults"));
    expect(capabilityBodies).not.toMatch(/\bEXECUTE\b|format\s*\(/i);
    expect(sql).toMatch(/requested_category text, requested_student_id uuid, requested_case_id uuid/);
    expect(sql).toContain("requested_category NOT IN ('payment_follow_up','kitchen_follow_up')");
    expect(sql).toContain("requested_case_id IS NULL OR c.id=requested_case_id");
  });
  it("constructs only the exact redacted JSON allowlists and masks contact in SQL",()=>{
    for(const key of ["eligibilityStatus","maskedEmail","maskedPhone","creditsGranted","priceCents","refundedCredits","mealName","reservedAt","category","state","openedAt"]) expect(sql).toContain(`'${key}'`);
    for(const forbidden of ["squareCustomerId","creditBalance","squarePaymentId","squareOrderId","sourceEventId","idempotencyKey","provider","modifiers","mealCatalogObjectId","sourceId","sourceType","reason","metadata"]) expect(sql).not.toContain(`'${forbidden}'`);
    expect(sql).toMatch(/left\(s\.normalized_email,1\).*split_part\(s\.normalized_email,'@',2\)/s);
    expect(sql).toMatch(/'\+'\|\|pg_catalog\.repeat\('\*',pg_catalog\.length\(s\.normalized_phone\)-5\)\|\|pg_catalog\.right\(s\.normalized_phone,4\)/);
    expect(sql).toContain("jsonb_strip_nulls");
  });
  it("normalizes hostile ACLs and grants the runtime exactly eleven non-grantable capabilities",()=>{
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM downtown_u_operator_runtime");
    expect(sql).toMatch(/<>11/); expect(sql).toMatch(/is_grantable/);
    for(const read of reads) expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.downtown_u_operator_read_${read}\\(`));
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.downtown_u_operator_read_principal/);
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]* TO (?:PUBLIC|downtown_u_runtime|downtown_u_jobs|downtown_u_kitchen_jobs)/i);
  });
});
