import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReadItems } from "../read-types";

const baseUrl=process.env.TEST_DATABASE_URL; const run=baseUrl?describe:describe.skip;
const suffix=`${process.pid}_${Date.now()}`; const dbName=`du_dashboard_${suffix}`; const login=`du_dashboard_login_${suffix}`;
const names=["downtown_u_phase1","downtown_u_webhook_events","downtown_u_payment_activation","downtown_u_refund_activation","downtown_u_auth","downtown_u_student_portal","downtown_u_checkout","downtown_u_kitchen_outbox","downtown_u_operator_audit","downtown_u_operator_auth_capabilities","downtown_u_operator_dashboard_reads"];
const migrations=names.map((n,i)=>readFileSync(resolve(process.cwd(),"db/migrations",`2026080400${String(i+1).padStart(2,"0")}_${n}.sql`),"utf8"));
let admin:Pool,database:Pool; let seq=1;
const studentA="20000000-0000-4000-8000-000000000001"; const studentB="20000000-0000-4000-8000-000000000002";
type TestPrincipal={account:string;session:string;proof:Buffer};
function qi(x:string){return `"${x.replaceAll('"','""')}"`;}
function id(){return `30000000-0000-4000-8000-${String(seq++).padStart(12,"0")}`;}
async function asOperator<T>(fn:(c:PoolClient)=>Promise<T>){const c=await database.connect();try{await c.query(`SET SESSION AUTHORIZATION ${qi(login)}`);return await fn(c);}finally{await c.query("RESET SESSION AUTHORIZATION").catch(()=>undefined);c.release();}}
async function principal(role:string|string[]){
  const account=id(),flow=id(),session=id(),proof=Buffer.alloc(32,seq);
  await database.query(`INSERT INTO downtown_u_operator_accounts(id,normalized_email,normalized_phone,display_name,provisioning_reference) VALUES($1,$2,$3,'Dashboard test',$4)`,[account,`dashboard-${seq}@example.edu`,`+1202555${String(seq).padStart(4,"0")}`,`dashboard:${seq}`]);
  for(const roleCode of typeof role==="string"?[role]:role) await database.query("INSERT INTO downtown_u_operator_account_roles(account_id,role_code,assigned_by_reference) VALUES($1,$2,$3)",[account,roleCode,`assign:${seq}:${roleCode}`]);
  await database.query(`INSERT INTO downtown_u_operator_auth_flows(id,operator_id,flow_verifier,status,created_at,updated_at,expires_at,completed_at,consumed_at)
    VALUES($1,$2,$3,'consumed',clock_timestamp()-interval '1 hour',clock_timestamp(),clock_timestamp()-interval '45 minutes',clock_timestamp()-interval '50 minutes',clock_timestamp()-interval '49 minutes')`,[flow,account,Buffer.alloc(32,seq)]);
  await database.query(`INSERT INTO downtown_u_operator_sessions(id,operator_id,consumed_auth_flow_id,session_verifier,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,'active',clock_timestamp()+interval '7 hours',clock_timestamp()+interval '20 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 hour',clock_timestamp())`,[session,account,flow,proof]);
  return {account,session,proof};
}
async function read(name:string,principal:TestPrincipal,args:unknown[]){return asOperator(async c=>(await c.query(`SELECT * FROM downtown_u_operator_read_${name}($1,1::smallint,$2,$3,${args.map((_,i)=>`$${i+4}`).join(",")})`,[principal.session,principal.proof,`dashboard-correlation-${seq++}`, ...args])).rows[0]);}

run.sequential("operator redacted dashboard reads on stock PostgreSQL 16",()=>{
  let reviewer:TestPrincipal,reconciler:TestPrincipal,adjuster:TestPrincipal,auditor:TestPrincipal,union:TestPrincipal;
  beforeAll(async()=>{
    admin=new Pool({connectionString:baseUrl,max:2}); const v=Number((await admin.query("show server_version_num")).rows[0].server_version_num); if(v<160000||v>=170000)throw new Error("PostgreSQL 16 required");
    await admin.query(`CREATE DATABASE ${qi(dbName)}`); const u=new URL(baseUrl!);u.pathname=`/${dbName}`;database=new Pool({connectionString:u.toString(),max:8});
    for(const migration of migrations)await database.query(migration);
    await admin.query(`CREATE ROLE ${qi(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await admin.query(`GRANT downtown_u_operator_runtime TO ${qi(login)}`);
    await database.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp()");
    reviewer=await principal("eligibility_reviewer"); reconciler=await principal("reconciliation_operator"); adjuster=await principal("credit_adjuster"); auditor=await principal("audit_exporter"); union=await principal(["eligibility_reviewer","credit_adjuster"]);
    await database.query(`INSERT INTO downtown_u_students(id,normalized_email,normalized_phone,eligibility_status,created_at,updated_at) VALUES
      ($1,'alpha.student@example.edu','+12025550123','pending','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z'),
      ($2,'beta.student@example.edu','+12025550999','approved','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`,[studentA,studentB]);
    await database.query(`INSERT INTO downtown_u_plan_purchases(id,student_id,plan_id,credits_granted,price_cents,square_payment_id,square_order_id,source_event_id,status,paid_at,created_at,updated_at)
      VALUES($1,$2,'flex-5',5,6000,'secret-payment','secret-order','secret-source','paid','2026-01-03','2026-01-03','2026-01-03')`,[id(),studentA]);
    await database.query("INSERT INTO downtown_u_meal_rules(id,display_name,square_catalog_object_id,base_credits,active) VALUES('rule-test','Rule Test','rule-secret-catalog',2,false)");
    const rule=(await database.query("SELECT id FROM downtown_u_meal_rules ORDER BY id LIMIT 1")).rows[0].id; const redemption=id();
    await database.query(`INSERT INTO downtown_u_redemptions(id,student_id,credits,idempotency_key,status,reserved_at,expires_at,created_at,updated_at)
      VALUES($1,$2,2,'secret-redemption-key','reserved','2026-01-04','2027-01-04','2026-01-04','2026-01-04')`,[redemption,studentA]);
    await database.query(`INSERT INTO downtown_u_reservation_snapshots(redemption_id,meal_rule_id,meal_public_id,meal_display_name,meal_square_catalog_object_id,modifiers,credits,created_at)
      VALUES($1,$2,'meal-public','Trusted Meal','secret-catalog','[{"id":"m1","name":"Secret modifier","squareCatalogObjectId":"secret-modifier","creditDelta":0}]',2,'2026-01-04')`,[redemption,rule]);
    const caseClient=await database.connect();
    try { await caseClient.query("BEGIN"); await caseClient.query("SELECT set_config('downtown_u.operator_write',pg_backend_pid()::text||':'||pg_current_xact_id()::text,true)");
      await caseClient.query(`INSERT INTO downtown_u_operator_reconciliation_cases(id,source_type,source_id,student_id,reason_code,reason,idempotency_key,correlation_id,origin,created_at)
        VALUES($1,'refund','secret-provider-id',$2,'secret_reason','secret free text','secret-case-idempotency-0001','seed-case-correlation-0001','migration_backfill','2026-01-05')`,[id(),studentA]);
      await caseClient.query("COMMIT");
    } catch(error) { await caseClient.query("ROLLBACK"); throw error; } finally { caseClient.release(); }
  },30_000);
  afterAll(async()=>{await database?.end();if(admin){await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[dbName]);await admin.query(`DROP DATABASE IF EXISTS ${qi(dbName)}`);await admin.query(`DROP ROLE IF EXISTS ${qi(login)}`);await admin.end();}},30_000);

  it("returns exact redacted allowlists and exact SQL masks",async()=>{
    const students=await read("students",reviewer,[101,null,null,null,null]); expect(students.outcome).toBe("authorized"); expect(students.items).toHaveLength(2);
    expect(() => validateReadItems("students",students.items)).not.toThrow();
    expect(students.items[1]).toMatchObject({maskedEmail:"a***@e***.edu",maskedPhone:"+*******0123"});
    expect(Object.keys(students.items[0]).sort()).toEqual(["createdAt","eligibilityStatus","id","maskedEmail","maskedPhone","updatedAt"]);
    const purchases=await read("purchases",reconciler,[101,null,null,null,null,null]); expect(Object.keys(purchases.items[0]).sort()).toEqual(["createdAt","creditsGranted","currency","id","paidAt","planId","priceCents","refundedCredits","status","studentId","updatedAt"]);
    const redemptions=await read("redemptions",reconciler,[101,null,null,null,null,null]); expect(redemptions.items[0].mealName).toBe("Trusted Meal"); expect(Object.keys(redemptions.items[0]).sort()).toEqual(["createdAt","credits","expiresAt","id","mealName","reservedAt","status","studentId","updatedAt"]);
    const cases=await read("reconciliation",reconciler,[101,null,null,null,null,null,null]); expect(cases.items[0]).toMatchObject({category:"payment_follow_up",state:"needs_review",studentId:studentA});
    expect(Object.keys(cases.items[0]).sort()).toEqual(["category","id","openedAt","state","studentId"]);
    const serialized=JSON.stringify({students,purchases,redemptions,cases}); for(const secret of ["alpha.student","secret-payment","secret-order","secret-source","secret-redemption-key","secret-catalog","Secret modifier","secret-provider-id","secret_reason","secret free text","secret-case-idempotency"])expect(serialized).not.toContain(secret);
  });

  it("enforces global versus exact scope role matrix and audit denial",async()=>{
    expect((await read("students",reviewer,[10,null,null,null,null])).outcome).toBe("authorized");
    expect((await read("purchases",reviewer,[10,null,null,null,studentA,null])).outcome).toBe("denied");
    expect((await read("redemptions",reviewer,[10,null,null,null,studentA,null])).outcome).toBe("denied");
    expect((await read("reconciliation",reviewer,[10,null,null,null,null,null,null])).outcome).toBe("denied");
    expect((await read("students",reconciler,[10,null,null,null,null])).outcome).toBe("authorized");
    expect((await read("students",reconciler,[10,null,null,null,studentA])).outcome).toBe("authorized");
    expect((await read("purchases",reconciler,[10,null,null,null,null,null])).outcome).toBe("authorized");
    expect((await read("purchases",reconciler,[10,null,null,null,studentA,null])).outcome).toBe("authorized");
    expect((await read("redemptions",reconciler,[10,null,null,null,null,null])).outcome).toBe("authorized");
    expect((await read("redemptions",reconciler,[10,null,null,null,studentA,null])).outcome).toBe("authorized");
    expect((await read("students",adjuster,[10,null,null,null,null])).outcome).toBe("denied");
    expect((await read("students",adjuster,[10,null,null,null,studentA])).outcome).toBe("authorized");
    expect((await read("purchases",adjuster,[10,null,null,null,studentA,null])).outcome).toBe("authorized");
    expect((await read("purchases",adjuster,[10,null,null,null,null,null])).outcome).toBe("denied");
    expect((await read("redemptions",adjuster,[10,null,null,null,studentA,null])).outcome).toBe("authorized");
    expect((await read("redemptions",adjuster,[10,null,null,null,null,null])).outcome).toBe("denied");
    expect((await read("reconciliation",adjuster,[10,null,null,null,null,null,null])).outcome).toBe("denied");
    expect((await read("students",union,[10,null,null,null,null])).outcome).toBe("authorized");
    expect((await read("redemptions",union,[10,null,null,null,studentA,null])).outcome).toBe("authorized");
    expect((await read("students",auditor,[10,null,null,null,studentA])).outcome).toBe("denied");
    expect((await read("purchases",auditor,[10,null,null,null,studentA,null])).outcome).toBe("denied");
    expect((await read("redemptions",auditor,[10,null,null,null,studentA,null])).outcome).toBe("denied");
    expect((await read("reconciliation",auditor,[10,null,null,null,null,null,null])).outcome).toBe("denied");
  });

  it("rejects invalid inputs and paginates deterministic timestamp ties without overlap",async()=>{
    expect((await read("students",reviewer,[0,null,null,null,null])).outcome).toBe("invalid");
    expect((await read("students",reviewer,[102,null,null,null,null])).outcome).toBe("invalid");
    expect((await read("students",reviewer,[10,new Date(),null,null,null])).outcome).toBe("invalid");
    expect((await read("students",reviewer,[10,null,studentA,null,null])).outcome).toBe("invalid");
    expect((await read("students",reviewer,[10,null,null,"wrong",null])).outcome).toBe("invalid");
    expect((await read("reconciliation",reconciler,[10,null,null,null,"invalid_category",null,null])).outcome).toBe("invalid");
    const categoryFiltered=await read("reconciliation",reconciler,[101,null,null,null,"payment_follow_up",studentA,null]);
    expect(categoryFiltered).toMatchObject({outcome:"authorized",items:[expect.objectContaining({studentId:studentA,category:"payment_follow_up"})]});
    const caseId=(await read("reconciliation",reconciler,[101,null,null,null,null,null,null])).items[0].id;
    expect((await read("reconciliation",reconciler,[101,null,null,null,null,null,caseId])).items.map((item:{id:string})=>item.id)).toEqual([caseId]);
    const first=await read("students",reviewer,[1,null,null,null,null]); const cursor=first.items[0];
    const second=await read("students",reviewer,[1,cursor.createdAt,cursor.id,null,null]); expect(second.items).toHaveLength(1);expect(second.items[0].id).not.toBe(cursor.id);
  });

  it("rechecks credentials, account, gate and role every call and denies direct access",async()=>{
    expect((await read("students",reviewer,[1,null,null,null,null])).outcome).toBe("authorized");
    await expect(asOperator(c=>c.query("SELECT * FROM downtown_u_students"))).rejects.toMatchObject({code:"42501"});
    const wrong=await asOperator(async c=>(await c.query("SELECT * FROM downtown_u_operator_read_students($1,1::smallint,$2,'wrong-proof-correlation-0001',1,NULL,NULL,NULL,NULL)",[reviewer.session,Buffer.alloc(32,9)])).rows[0]); expect(wrong).toEqual({outcome:"invalid",items:null});
    const validation=await asOperator(async c=>(await c.query("SELECT outcome FROM downtown_u_operator_auth_validate_session($1,1::smallint,$2,'eligibility_reviewer','read','dashboard-prior-validation-0001')",[reviewer.session,reviewer.proof])).rows[0]); expect(validation.outcome).toBe("authorized");
    await database.query("UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='revoke:test' WHERE account_id=$1 AND role_code='eligibility_reviewer' AND revoked_at IS NULL",[reviewer.account]);
    expect((await read("students",reviewer,[1,null,null,null,null])).outcome).toBe("denied");
    await database.query("UPDATE downtown_u_operator_config SET read_enabled=false,updated_at=clock_timestamp()");
    try { expect((await read("purchases",reconciler,[1,null,null,null,null,null])).outcome).toBe("denied"); }
    finally { await database.query("UPDATE downtown_u_operator_config SET read_enabled=true,updated_at=clock_timestamp()"); }
    const disabled=await principal("reconciliation_operator"); await database.query("UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",[disabled.account]);
    expect((await read("purchases",disabled,[1,null,null,null,null,null])).outcome).toBe("denied");
    const expired=await principal("reconciliation_operator"); await database.query("UPDATE downtown_u_operator_sessions SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.session]);
    expect((await read("purchases",expired,[1,null,null,null,null,null])).outcome).toBe("invalid");
    const revoked=await principal("reconciliation_operator"); await database.query("UPDATE downtown_u_operator_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1",[revoked.session]);
    expect((await read("purchases",revoked,[1,null,null,null,null,null])).outcome).toBe("invalid");
  });

  it("does not serialize authorized reads for different sessions and accounts on the singleton config",async()=>{
    const first=await principal("reconciliation_operator");
    const second=await principal("reconciliation_operator");
    const a=await database.connect(); const b=await database.connect();
    try {
      await a.query("BEGIN"); await a.query(`SET LOCAL SESSION AUTHORIZATION ${qi(login)}`);
      const held=await a.query("SELECT outcome FROM downtown_u_operator_read_purchases($1,1::smallint,$2,'dashboard-concurrency-held-0001',1,NULL,NULL,NULL,NULL,NULL)",[first.session,first.proof]);
      expect(held.rows[0].outcome).toBe("authorized");

      await b.query("BEGIN"); await b.query(`SET LOCAL SESSION AUTHORIZATION ${qi(login)}`); await b.query("SET LOCAL statement_timeout='750ms'");
      const concurrent=await b.query("SELECT outcome FROM downtown_u_operator_read_purchases($1,1::smallint,$2,'dashboard-concurrency-free-0002',1,NULL,NULL,NULL,NULL,NULL)",[second.session,second.proof]);
      expect(concurrent.rows[0].outcome).toBe("authorized");
      await b.query("ROLLBACK"); await a.query("ROLLBACK");
    } catch(error) { await b.query("ROLLBACK").catch(()=>undefined); await a.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally { b.release(); a.release(); }
  });

  it("keeps account disable, gate-off and role revoke updates behind the authorization SHARE locks",async()=>{
    const target=await principal("reconciliation_operator");
    const checks=[
      ["UPDATE downtown_u_operator_accounts SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",target.account],
      ["UPDATE downtown_u_operator_config SET read_enabled=false,updated_at=clock_timestamp() WHERE singleton=true",null],
      ["UPDATE downtown_u_operator_account_roles SET revoked_at=clock_timestamp(),revocation_reference='concurrency:test' WHERE account_id=$1 AND revoked_at IS NULL",target.account],
    ] as const;
    for(const [update,key] of checks){
      const reader=await database.connect(); const adminUpdate=await database.connect();
      try{
        await reader.query("BEGIN"); await reader.query(`SET LOCAL SESSION AUTHORIZATION ${qi(login)}`);
        const authorized=await reader.query("SELECT outcome FROM downtown_u_operator_read_purchases($1,1::smallint,$2,$3,1,NULL,NULL,NULL,NULL,NULL)",[target.session,target.proof,`dashboard-linearize-${seq++}`]);
        expect(authorized.rows[0].outcome).toBe("authorized");
        await adminUpdate.query("BEGIN"); await adminUpdate.query("SET LOCAL statement_timeout='250ms'");
        await expect(adminUpdate.query(update,key===null?[]:[key])).rejects.toMatchObject({code:"57014"});
        await adminUpdate.query("ROLLBACK"); await reader.query("ROLLBACK");
      }catch(error){await adminUpdate.query("ROLLBACK").catch(()=>undefined);await reader.query("ROLLBACK").catch(()=>undefined);throw error;}
      finally{adminUpdate.release();reader.release();}
    }
  });

  it("exposes exactly eleven runtime functions while the helper remains owner-only",async()=>{
    const rows=await asOperator(c=>c.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'downtown_u_operator_%' AND has_function_privilege(current_user,p.oid,'EXECUTE')`));
    expect(rows.rows).toHaveLength(11); expect(rows.rows.some(r=>r.proname==="downtown_u_operator_read_principal")).toBe(false);
  });
});
