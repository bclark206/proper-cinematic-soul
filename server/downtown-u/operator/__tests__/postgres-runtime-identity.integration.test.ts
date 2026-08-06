import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDowntownUOperatorRuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresOperatorAuthStore } from "../postgres-auth-store";

const baseUrl=process.env.TEST_DATABASE_URL;
const run=baseUrl ? describe : describe.skip;
const suffix=`${process.pid}_${Date.now()}`;
const databaseName=`du_operator_identity_${suffix}`;
const login=`du_operator_identity_login_${suffix}`;
const extra=`du_operator_identity_extra_${suffix}`;
const migrations=[1,2,3,4,5,6,7,8,9,10].map(n=>readFileSync(resolve(process.cwd(),"db/migrations",`2026080400${String(n).padStart(2,"0")}_${[
  "downtown_u_phase1","downtown_u_webhook_events","downtown_u_payment_activation","downtown_u_refund_activation","downtown_u_auth",
  "downtown_u_student_portal","downtown_u_checkout","downtown_u_kitchen_outbox","downtown_u_operator_audit","downtown_u_operator_auth_capabilities",
][n-1]}.sql`),"utf8"));
let admin:Pool; let database:Pool; let operator:Pool;
function qi(x:string){return `"${x.replaceAll('"','""')}"`;}

run.sequential("operator PostgreSQL identity attestation on stock PostgreSQL 16",()=>{
  beforeAll(async()=>{
    admin=new Pool({connectionString:baseUrl,max:2});
    const version=Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    if(version<160000||version>=170000) throw new Error("PostgreSQL 16 required");
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`);
    const u=new URL(baseUrl!); u.pathname=`/${databaseName}`; database=new Pool({connectionString:u.toString(),max:2});
    for(const migration of migrations) await database.query(migration);
    await admin.query(`CREATE ROLE ${qi(login)} LOGIN PASSWORD 'operator-identity-test-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${qi(extra)} NOLOGIN`);
    await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(login)}`);
    const direct=new URL(u); direct.hostname="127.0.0.1"; direct.username=login; direct.password="operator-identity-test-password";
    operator=new Pool({connectionString:direct.toString(),max:1});
  },30_000);
  afterAll(async()=>{
    await operator?.end(); await database?.end();
    if(admin){
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`); await admin.query(`DROP ROLE IF EXISTS ${qi(extra)}`); await admin.end();
    }
  },30_000);

  it("accepts a dedicated LOGIN and exposes exactly the seven pinned signatures",async()=>{
    const client=await operator.connect();
    try { await client.query("BEGIN"); await expect(assertDowntownUOperatorRuntimeIdentity(client)).resolves.toBeUndefined(); await client.query("ROLLBACK"); }
    finally{client.release();}
    const rows=await operator.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_%' AND has_function_privilege(current_user,p.oid,'EXECUTE') ORDER BY p.oid::regprocedure::text COLLATE "C"`);
    expect(rows.rows.map(r=>r.signature)).toEqual([
      "downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text)",
      "downtown_u_operator_auth_begin_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)",
      "downtown_u_operator_auth_finish_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)",
      "downtown_u_operator_auth_finish_sign_in(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)",
      "downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text)",
      "downtown_u_operator_auth_validate_session(uuid,smallint,bytea,text,text,text)",
      "downtown_u_operator_auth_verify_email(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)",
    ]);
  });

  it("runs preflight and one real capability in the store transaction",async()=>{
    const store=new PostgresOperatorAuthStore(operator);
    await expect(store.begin({
      flowId:"123e4567-e89b-42d3-a456-426614174000",normalizedEmail:"unknown@example.test",version:1,
      flowDigest:Buffer.alloc(32,1),emailChallengeId:"223e4567-e89b-42d3-a456-426614174000",
      emailChallengeDigest:Buffer.alloc(32,2),correlationId:"operator-store-correlation-0001",
    })).resolves.toEqual({outcome:"accepted"});
  });

  async function rejectsMutation(sql:string):Promise<void>{
    const c=await database.connect();
    try{
      await c.query("BEGIN"); await c.query(sql); await c.query(`SET LOCAL SESSION AUTHORIZATION ${qi(login)}`);
      await expect(assertDowntownUOperatorRuntimeIdentity(c)).rejects.toThrow("Unsafe Downtown U operator database identity");
      await c.query("RESET SESSION AUTHORIZATION"); await c.query("ROLLBACK");
    }catch(e){await c.query("RESET SESSION AUTHORIZATION").catch(()=>undefined);await c.query("ROLLBACK").catch(()=>undefined);throw e;}
    finally{c.release();}
  }

  it("rejects role config, extra closure, ownership and every direct privilege class",async()=>{
    await rejectsMutation(`ALTER ROLE ${qi(login)} SET statement_timeout='1s'`);
    await rejectsMutation(`GRANT ${qi(extra)} TO ${qi(login)}`);
    await rejectsMutation(`GRANT downtown_u_runtime TO ${qi(login)}`);
    await rejectsMutation(`GRANT ${qi(login)} TO CURRENT_USER`);
    await rejectsMutation(`GRANT CREATE ON DATABASE ${qi(databaseName)} TO ${qi(login)}`);
    await rejectsMutation(`GRANT CREATE ON SCHEMA public TO ${qi(login)}`);
    await rejectsMutation(`GRANT TRIGGER ON downtown_u_operator_accounts TO ${qi(login)}`);
    await rejectsMutation(`GRANT REFERENCES (id) ON downtown_u_operator_accounts TO ${qi(login)}`);
    await rejectsMutation(`CREATE SEQUENCE downtown_u_operator_hostile_sequence; GRANT USAGE ON SEQUENCE downtown_u_operator_hostile_sequence TO ${qi(login)}`);
    await rejectsMutation(`GRANT EXECUTE ON FUNCTION downtown_u_operator_append_only_guard() TO ${qi(login)}`);
  });

  it("rejects altered relation indexes, constraints, triggers, function config/owner/ACL/signature/body",async()=>{
    await rejectsMutation("DROP INDEX downtown_u_operator_auth_flows_rate_idx");
    await rejectsMutation("ALTER TABLE downtown_u_operator_accounts DROP CONSTRAINT downtown_u_operator_accounts_pkey CASCADE");
    await rejectsMutation("ALTER TABLE downtown_u_operator_accounts DISABLE TRIGGER downtown_u_operator_accounts_immutable_identity_guard");
    await rejectsMutation("ALTER FUNCTION downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text) SET search_path=public");
    await rejectsMutation(`ALTER FUNCTION downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text) OWNER TO ${qi(extra)}`);
    await rejectsMutation("GRANT EXECUTE ON FUNCTION downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text) TO PUBLIC");
    await rejectsMutation(`CREATE FUNCTION downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text,text) RETURNS TABLE(outcome text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN QUERY SELECT ''accepted''::text; END'`);
    const def=(await database.query<{definition:string}>("SELECT pg_get_functiondef('downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text)'::regprocedure) definition")).rows[0].definition;
    const altered=def.replace("BEGIN\n", "BEGIN\n  PERFORM 1;\n");
    expect(altered).not.toBe(def); await rejectsMutation(altered);
  });

  it("pins the exact owner-only executable dependency set and every helper descriptor",async()=>{
    const helper=(await database.query<{signature:string}>(`SELECT p.oid::regprocedure::text signature FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND p.proname LIKE 'downtown_u_operator_%' AND p.proname NOT LIKE 'downtown_u_operator_auth_%'
      ORDER BY p.oid::regprocedure::text COLLATE "C"`)).rows.map(row=>row.signature);
    expect(helper).toEqual([
      "downtown_u_operator_accounts_immutable_identity_guard()",
      "downtown_u_operator_append_only_guard()",
      "downtown_u_operator_config_guard()",
      "downtown_u_operator_sync_kitchen_case()",
      "downtown_u_operator_sync_refund_case()",
    ]);
    const appendDef=(await database.query<{definition:string}>("SELECT pg_get_functiondef('downtown_u_operator_append_only_guard()'::regprocedure) definition")).rows[0].definition;
    await rejectsMutation(appendDef.replace("BEGIN\n", "BEGIN\n  PERFORM 1;\n"));
    await rejectsMutation("ALTER FUNCTION downtown_u_operator_sync_refund_case() SET search_path=public");
    await rejectsMutation(`ALTER FUNCTION downtown_u_operator_sync_kitchen_case() OWNER TO ${qi(extra)}`);
    await rejectsMutation("GRANT EXECUTE ON FUNCTION downtown_u_operator_accounts_immutable_identity_guard() TO PUBLIC");
    await rejectsMutation(`CREATE FUNCTION downtown_u_operator_append_only_guard(text) RETURNS text
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN $1; END'`);
  });

  it("rejects SET ROLE on the same checked-out client",async()=>{
    const c=await operator.connect();
    try{await c.query("BEGIN");await c.query("SET LOCAL ROLE downtown_u_operator_runtime");
      await expect(assertDowntownUOperatorRuntimeIdentity(c)).rejects.toThrow("Unsafe Downtown U operator database identity");await c.query("ROLLBACK");}
    finally{c.release();}
  });
});
