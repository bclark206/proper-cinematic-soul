import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
const sql=readFileSync(resolve(process.cwd(),"db/migrations/202608040005_downtown_u_auth.sql"),"utf8");
describe("Downtown U auth migration contract",()=>{
  it("stores only versioned fixed-length digests",()=>{
    expect(sql).toContain("verifier_digest BYTEA NOT NULL CHECK (octet_length(verifier_digest)=32)");
    expect(sql).toContain("token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest)=32)");
    expect(sql).not.toMatch(/plaintext|delivery_body|provider_secret/i);
  });
  it("exposes only four definer capabilities with fixed catalog search paths",()=>{
    expect(sql.match(/SECURITY DEFINER SET search_path=pg_catalog/g)).toHaveLength(4);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.downtown_u_(create_auth_challenge|consume_auth_challenge|validate_auth_session|revoke_auth_session)/g)).toHaveLength(4);
  });
  it("keeps all auth security policy values inside fixed-signature database capabilities",()=>{
    expect(sql).toContain("requested_method TEXT, requested_version SMALLINT, requested_digest BYTEA\n) RETURNS TABLE");
    expect(sql).toContain("requested_session_version SMALLINT, requested_session_digest BYTEA\n) RETURNS TABLE");
    expect(sql).not.toMatch(/requested_(ttl|max_attempts|cooldown|window|session_ttl)/);
    expect(sql).toContain("pg_catalog.make_interval(secs=>600),5,now_at");
    expect(sql).toContain("pg_catalog.make_interval(secs=>3600)");
    expect(sql).toContain("pg_catalog.make_interval(secs=>60)");
    expect(sql).toContain("pg_catalog.make_interval(secs=>86400)");
  });
  it("revokes direct table access and protects both mutation and truncate",()=>{
    expect(sql).toContain("REVOKE ALL ON public.downtown_u_auth_challenges,public.downtown_u_auth_sessions FROM PUBLIC,downtown_u_runtime");
    expect(sql.match(/_no_truncate BEFORE TRUNCATE/g)).toHaveLength(2);
    expect(sql.match(/_immutable BEFORE UPDATE OR DELETE/g)).toHaveLength(2);
  });
  it("uses the database clock, row locks, attempt limits, and eligibility binding",()=>{
    expect(sql).toContain("pg_catalog.clock_timestamp()"); expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("attempt_count=attempt_count+1"); expect(sql).toContain("eligibility_status='approved'");
    expect(sql).toContain("deleted_at IS NULL");
  });
});
