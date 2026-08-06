import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthCryptography, generateOpaqueId } from "../auth";
import { PostgresAuthStore } from "../postgres-auth-store";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";

const baseUrl=process.env.TEST_DATABASE_URL;
const run=baseUrl?describe:describe.skip;
const suffix=`${process.pid}_${Date.now()}`;
const databaseName=`downtown_u_auth_test_${suffix}`;
const runtimeLogin=`downtown_u_auth_login_${suffix}`;
const runtimePassword=randomUUID().replaceAll("-","");
const migrations=[1,2,3,4,5,6,7].map((number)=>readFileSync(resolve(process.cwd(),"db/migrations",
  `20260804000${number}_${["downtown_u_phase1","downtown_u_webhook_events","downtown_u_payment_activation","downtown_u_refund_activation","downtown_u_auth","downtown_u_student_portal","downtown_u_checkout"][number-1]}.sql`),"utf8"));
let admin:Pool; let owner:Pool; let runtime:Pool; let store:PostgresAuthStore;
const cryptography=createAuthCryptography("cGhhc2UzYS1hdXRoLWludGVncmF0aW9uLWtleS0wMDA");
const createSignature="(text,text,text,text,smallint,bytea)";
const consumeSignature="(text,smallint,bytea,text,smallint,bytea)";
const createCall="($1::text,$2::text,$3::text,$4::text,$5::smallint,$6::bytea)";
const consumeCall="($1::text,$2::smallint,$3::bytea,$4::text,$5::smallint,$6::bytea)";
function qi(value:string){return `"${value.replaceAll('"','""')}"`;}
function code(error:unknown){return typeof error==="object"&&error!==null&&"code" in error?String(error.code):undefined;}
async function seed(email:string,status="approved",phone?:string) {
  return (await owner.query<{id:string}>(`INSERT INTO downtown_u_students(normalized_email,normalized_phone,eligibility_status,approved_at)
    VALUES($1,$2,$3,CASE WHEN $3='approved' THEN clock_timestamp() END) RETURNING id`,[email,phone??null,status])).rows[0].id;
}
async function challenge(contact:string,verifier:string,type:"email"|"phone"="email") {
  const challengeId=generateOpaqueId();
  const result=await store.createChallenge({challengeId,contactType:type,normalizedContact:contact,
    method:type==="email"?"email_magic_link":"sms_otp",digest:cryptography.digestChallenge(verifier)});
  expect(result.challengeId).toBe(challengeId); return challengeId;
}
async function consume(challengeId:string,verifier:string,sessionId=generateOpaqueId(),bearer=generateOpaqueId()) {
  return {result:await store.consumeChallenge({challengeId,digest:cryptography.digestChallenge(verifier),sessionId,
    sessionDigest:cryptography.digestSession(bearer)}),sessionId,bearer};
}
async function ageChallenge(id:string,age:string,status="revoked") {
  await owner.query("ALTER TABLE downtown_u_auth_challenges DISABLE TRIGGER downtown_u_auth_challenges_immutable");
  try { await owner.query(`UPDATE downtown_u_auth_challenges SET created_at=clock_timestamp()-$2::interval,
    expires_at=clock_timestamp()-$2::interval+interval '10 minutes',status=$3,
    revoked_at=CASE WHEN $3='revoked' THEN clock_timestamp() ELSE NULL END WHERE challenge_id=$1`,[id,age,status]); }
  finally { await owner.query("ALTER TABLE downtown_u_auth_challenges ENABLE TRIGGER downtown_u_auth_challenges_immutable"); }
}
async function expectPreflightRejects(){await expect(assertDowntownURuntimeIdentity(runtime)).rejects.toThrow("Unsafe Downtown U runtime database identity");}
async function drift(sql:string,restore:string) {
  await owner.query(sql);
  try { await expectPreflightRejects(); }
  finally { await owner.query(restore); }
  await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
}
async function driftFunctionBody(signature:string,body:string) {
  const original=(await owner.query<{definition:string}>(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition",[signature])).rows[0].definition;
  const changed=original.replace(/AS \$function\$[\s\S]*\$function\$/u,`AS $function$\n${body}\n$function$`);
  expect(changed).not.toBe(original);
  await owner.query(changed);
  try { await expectPreflightRejects(); }
  finally { await owner.query(original); }
  await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
}

run.sequential("hardened Downtown U authentication on PostgreSQL 16",()=>{
  beforeAll(async()=>{
    const parsed=new URL(baseUrl!); const baseDatabase=parsed.pathname.slice(1);
    const local=["localhost","127.0.0.1","::1"].includes(parsed.hostname);
    if(!local&&!/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(baseDatabase))
      throw new Error("Refusing auth integration tests against a non-test database");
    admin=new Pool({connectionString:baseUrl,max:2});
    await admin.query(`CREATE DATABASE ${qi(databaseName)}`); parsed.pathname=`/${databaseName}`;
    owner=new Pool({connectionString:parsed.toString(),max:20});
    expect(Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
    for(const migration of migrations) await owner.query(migration);
    await owner.query(`CREATE ROLE ${qi(runtimeLogin)} LOGIN PASSWORD '${runtimePassword}'`);
    await owner.query(`GRANT downtown_u_runtime TO ${qi(runtimeLogin)}`);
    const runtimeUrl=new URL(parsed); runtimeUrl.username=runtimeLogin; runtimeUrl.password=runtimePassword;
    runtime=new Pool({connectionString:runtimeUrl.toString(),max:20}); store=new PostgresAuthStore(runtime);
  },30_000);
  afterAll(async()=>{
    await runtime?.end(); await owner?.end();
    if(admin){await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(databaseName)}`); await admin.query(`DROP ROLE IF EXISTS ${qi(runtimeLogin)}`); await admin.end();}
  },30_000);

  describe("challenge lifecycle, rate limiting, and contact binding",()=>{
    it("enforces rolling five-per-hour independently of cooldown",async()=>{
      const email="rolling@example.com"; await seed(email);
      for(const minutes of [50,40,30,20,10]) { const id=await challenge(email,`rolling-${minutes}`); await ageChallenge(id,`${minutes} minutes`); }
      const sixth=await store.createChallenge({challengeId:generateOpaqueId(),contactType:"email",normalizedContact:email,
        method:"email_magic_link",digest:cryptography.digestChallenge("rolling-sixth")});
      expect(sixth).toEqual({outcome:"accepted"});
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_auth_challenges WHERE normalized_contact=$1",[email])).rows[0].n).toBe(5);
    });

    it("persists the fixed 600-second TTL, five attempts, and 60-second cooldown",async()=>{
      const email="fixed-challenge-policy@example.com"; await seed(email);
      const first=await challenge(email,"fixed-first");
      expect((await owner.query(`SELECT max_attempts,
        extract(epoch FROM expires_at-created_at)::int ttl_seconds
        FROM downtown_u_auth_challenges WHERE challenge_id=$1`,[first])).rows[0])
        .toEqual({max_attempts:5,ttl_seconds:600});
      await ageChallenge(first,"59 seconds","active");
      const suppressed=await store.createChallenge({challengeId:generateOpaqueId(),contactType:"email",normalizedContact:email,
        method:"email_magic_link",digest:cryptography.digestChallenge("too-soon")});
      expect(suppressed).toEqual({outcome:"accepted"});
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_auth_challenges WHERE normalized_contact=$1",[email])).rows[0].n).toBe(1);
      await ageChallenge(first,"61 seconds","active");
      const accepted=await store.createChallenge({challengeId:generateOpaqueId(),contactType:"email",normalizedContact:email,
        method:"email_magic_link",digest:cryptography.digestChallenge("after-cooldown")});
      expect(accepted.challengeId).toBeTruthy();
    });

    it("atomically replaces an active challenge after cooldown and concurrent replacement leaves one active",async()=>{
      const email="replace@example.com"; await seed(email); const old=await challenge(email,"old"); await ageChallenge(old,"2 minutes","active");
      const replacement=await challenge(email,"replacement");
      expect((await owner.query("SELECT status FROM downtown_u_auth_challenges WHERE challenge_id=$1",[old])).rows[0].status).toBe("revoked");
      await ageChallenge(replacement,"2 minutes","active");
      const commands=["a","b"].map((v)=>({challengeId:generateOpaqueId(),contactType:"email" as const,normalizedContact:email,
        method:"email_magic_link" as const,digest:cryptography.digestChallenge(v)}));
      const results=await Promise.all(commands.map((command)=>store.createChallenge(command)));
      expect(results.every((result)=>result.outcome==="accepted")).toBe(true);
      expect(results.filter((result)=>result.challengeId)).toHaveLength(1);
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_auth_challenges WHERE normalized_contact=$1 AND status='active'",[email])).rows[0].n).toBe(1);
    });

    it("keeps nonexistent-account creation generic and consumes a correct verifier without a session",async()=>{
      const id=await challenge("absent@example.com","absent-secret");
      const {result}=await consume(id,"absent-secret"); expect(result).toEqual({outcome:"invalid"});
      expect((await owner.query("SELECT status,consumed_at IS NOT NULL consumed FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({status:"consumed",consumed:true});
    });

    it.each(["pending","rejected","suspended","deleted","contact-changed"])("consumes but does not authenticate when account is %s after issuance",async(kind)=>{
      const email=`transition-${kind}@example.com`; const studentId=await seed(email); const id=await challenge(email,"right");
      if(kind==="pending") await owner.query("UPDATE downtown_u_students SET eligibility_status='pending',approved_at=NULL WHERE id=$1",[studentId]);
      if(kind==="rejected") await owner.query("UPDATE downtown_u_students SET eligibility_status='rejected',approved_at=NULL,rejected_at=clock_timestamp() WHERE id=$1",[studentId]);
      if(kind==="suspended") await owner.query("UPDATE downtown_u_students SET eligibility_status='suspended',suspended_at=clock_timestamp() WHERE id=$1",[studentId]);
      if(kind==="deleted") await owner.query("UPDATE downtown_u_students SET deleted_at=clock_timestamp() WHERE id=$1",[studentId]);
      if(kind==="contact-changed") await owner.query("UPDATE downtown_u_students SET normalized_email=$2 WHERE id=$1",[studentId,`changed-${kind}@example.com`]);
      expect((await consume(id,"right")).result).toEqual({outcome:"invalid"});
      expect((await owner.query("SELECT status FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0].status).toBe("consumed");
    });

    it("transitions a challenge at its expiry boundary to expired",async()=>{
      const email="expiry@example.com"; await seed(email); const id=await challenge(email,"right");
      await owner.query("ALTER TABLE downtown_u_auth_challenges DISABLE TRIGGER downtown_u_auth_challenges_immutable");
      try { await owner.query(`UPDATE downtown_u_auth_challenges SET created_at=transaction_timestamp()-interval '10 minutes',
        expires_at=transaction_timestamp() WHERE challenge_id=$1`,[id]); }
      finally { await owner.query("ALTER TABLE downtown_u_auth_challenges ENABLE TRIGGER downtown_u_auth_challenges_immutable"); }
      expect((await consume(id,"right")).result).toEqual({outcome:"invalid"});
      expect((await owner.query("SELECT status FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0].status).toBe("expired");
    });

    it("binds a normalized phone to sms_otp and authenticates",async()=>{
      const phone="+14155550123"; const studentId=await seed("phone@example.com","approved",phone);
      const id=await challenge(phone,"042731","phone"); const {result}=await consume(id,"042731");
      expect(result).toMatchObject({outcome:"authenticated",studentId});
      expect((await owner.query("SELECT contact_type,method,normalized_contact FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({contact_type:"phone",method:"sms_otp",normalized_contact:phone});
    });

    it("fails closed for malformed direct create capability parameters without inserting",async()=>{
      const good=[generateOpaqueId(),"email","direct-malformed@example.com","email_magic_link",1,Buffer.alloc(32)];
      const cases:unknown[][]=[
        ["short",...good.slice(1)], [good[0],"fax",...good.slice(2)], [good[0],"email","UPPER@example.com",...good.slice(3)],
        [good[0],"email",good[2],"sms_otp",...good.slice(4)], [...good.slice(0,4),2,...good.slice(5)],
        [...good.slice(0,5),Buffer.alloc(31)],
      ];
      const before=(await owner.query("SELECT count(*)::int n FROM downtown_u_auth_challenges")).rows[0].n;
      for(const params of cases) await expect(runtime.query(`SELECT * FROM downtown_u_create_auth_challenge${createCall}`,params))
        .rejects.toSatisfy((error)=>code(error)==="P0001");
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_auth_challenges")).rows[0].n).toBe(before);
    });
  });

  describe("collisions, sessions, rollback, and secret persistence",()=>{
    it("makes a challenge-id collision generic and never overwrites the original",async()=>{
      await seed("collision-a@example.com"); await seed("collision-b@example.com");
      const id=await challenge("collision-a@example.com","original");
      const result=await store.createChallenge({challengeId:id,contactType:"email",normalizedContact:"collision-b@example.com",
        method:"email_magic_link",digest:cryptography.digestChallenge("replacement")});
      expect(result).toEqual({outcome:"accepted"});
      expect((await owner.query("SELECT normalized_contact,verifier_digest FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({normalized_contact:"collision-a@example.com",verifier_digest:cryptography.digestChallenge("original")});
    });

    it.each(["session-id","token-digest"])("rolls back challenge consumption on %s collision and permits a fresh retry",async(collision)=>{
      const email=`rollback-${collision}@example.com`; const studentId=await seed(email); const id=await challenge(email,"right");
      const occupiedId=generateOpaqueId(); const occupiedBearer=generateOpaqueId(); const occupiedDigest=cryptography.digestSession(occupiedBearer);
      await owner.query(`INSERT INTO downtown_u_auth_sessions(session_id,student_id,verifier_version,token_digest,expires_at)
        VALUES($1,$2,1,$3,clock_timestamp()+interval '1 day')`,[occupiedId,studentId,occupiedDigest]);
      const attemptedId=collision==="session-id"?occupiedId:generateOpaqueId();
      const attemptedDigest=collision==="token-digest"?occupiedDigest:cryptography.digestSession(generateOpaqueId());
      await expect(store.consumeChallenge({challengeId:id,digest:cryptography.digestChallenge("right"),sessionId:attemptedId,sessionDigest:attemptedDigest}))
        .resolves.toEqual({outcome:"invalid"});
      expect((await owner.query("SELECT status,consumed_at FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({status:"active",consumed_at:null});
      const fresh=await consume(id,"right"); expect(fresh.result).toMatchObject({outcome:"authenticated",studentId});
    });

    it("serializes wrong attempts and terminally exhausts a challenge",async()=>{
      const email="attempts@example.com"; await seed(email); const id=await challenge(email,"right");
      const results=await Promise.all(Array.from({length:10},()=>store.consumeChallenge({challengeId:id,
        digest:cryptography.digestChallenge("wrong"),sessionId:generateOpaqueId(),sessionDigest:cryptography.digestSession(generateOpaqueId())})));
      expect(results.every((result)=>result.outcome==="invalid")).toBe(true);
      expect((await owner.query("SELECT attempt_count,status FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({attempt_count:5,status:"exhausted"});
    });

    it("allows exactly one of concurrent correct consumes to create a session",async()=>{
      const email="concurrent-consume@example.com"; const studentId=await seed(email); const id=await challenge(email,"right");
      const commands=["first","second"].map((suffix)=>({challengeId:id,digest:cryptography.digestChallenge("right"),
        sessionId:generateOpaqueId(),sessionDigest:cryptography.digestSession(`bearer-${suffix}`)}));
      const results=await Promise.all(commands.map((command)=>store.consumeChallenge(command)));
      expect(results.filter((result)=>result.outcome==="authenticated")).toHaveLength(1);
      expect(results.filter((result)=>result.outcome==="invalid")).toHaveLength(1);
      expect((await owner.query("SELECT count(*)::int n FROM downtown_u_auth_sessions WHERE student_id=$1",[studentId])).rows[0].n).toBe(1);
      expect((await owner.query("SELECT status FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0].status).toBe("consumed");
    });

    it("returns invalid without mutation for malformed direct consume capability inputs",async()=>{
      const email="malformed-consume@example.com"; await seed(email); const id=await challenge(email,"right");
      const good=[id,1,cryptography.digestChallenge("right"),generateOpaqueId(),1,cryptography.digestSession("bearer")];
      const cases:unknown[][]=[["bad",...good.slice(1)],[good[0],2,...good.slice(2)],
        [...good.slice(0,2),Buffer.alloc(31),...good.slice(3)],[...good.slice(0,3),"bad",...good.slice(4)],
        [...good.slice(0,4),2,...good.slice(5)],[...good.slice(0,5),Buffer.alloc(31)]];
      for(const params of cases) expect((await runtime.query(`SELECT * FROM downtown_u_consume_auth_challenge${consumeCall}`,params)).rows[0].outcome).toBe("invalid");
      expect((await owner.query("SELECT status,attempt_count FROM downtown_u_auth_challenges WHERE challenge_id=$1",[id])).rows[0])
        .toEqual({status:"active",attempt_count:0});
    });

    it("persists the fixed 86400-second session TTL",async()=>{
      const email="fixed-session-policy@example.com"; await seed(email); const id=await challenge(email,"right");
      const {result,sessionId}=await consume(id,"right"); expect(result.outcome).toBe("authenticated");
      expect((await owner.query(`SELECT extract(epoch FROM expires_at-issued_at)::int ttl_seconds
        FROM downtown_u_auth_sessions WHERE session_id=$1`,[sessionId])).rows[0]).toEqual({ttl_seconds:86400});
    });

    it("validates only the exact live session and invalidates it on account suspension or deletion",async()=>{
      for(const state of ["suspended","deleted"] as const) {
        const email=`session-${state}@example.com`; const studentId=await seed(email); const id=await challenge(email,"right");
        const {sessionId,bearer}=await consume(id,"right"); const digest=cryptography.digestSession(bearer);
        await expect(store.validateSession({sessionId:generateOpaqueId(),digest})).resolves.toEqual({outcome:"invalid"});
        await expect(store.validateSession({sessionId,digest:cryptography.digestSession("wrong")})).resolves.toEqual({outcome:"invalid"});
        if(state==="suspended") await owner.query("UPDATE downtown_u_students SET eligibility_status='suspended',suspended_at=clock_timestamp() WHERE id=$1",[studentId]);
        else await owner.query("UPDATE downtown_u_students SET deleted_at=clock_timestamp() WHERE id=$1",[studentId]);
        await expect(store.validateSession({sessionId,digest})).resolves.toEqual({outcome:"invalid"});
      }
    });

    it("rejects expired sessions and makes revoke credential-bound and idempotent",async()=>{
      const studentId=await seed("revoke@example.com"); const id=await challenge("revoke@example.com","right");
      const {sessionId,bearer}=await consume(id,"right"); const digest=cryptography.digestSession(bearer);
      await expect(store.revokeSession({sessionId,digest:cryptography.digestSession("wrong")})).resolves.toEqual({outcome:"accepted"});
      await expect(store.validateSession({sessionId,digest})).resolves.toMatchObject({outcome:"valid",studentId});
      await expect(store.revokeSession({sessionId,digest})).resolves.toEqual({outcome:"accepted"});
      await expect(store.revokeSession({sessionId,digest})).resolves.toEqual({outcome:"accepted"});
      await expect(store.validateSession({sessionId,digest})).resolves.toEqual({outcome:"invalid"});
      const expiredId=generateOpaqueId(); const expiredDigest=cryptography.digestSession("expired-bearer");
      await owner.query(`INSERT INTO downtown_u_auth_sessions(session_id,student_id,verifier_version,token_digest,issued_at,expires_at,last_seen_at)
        VALUES($1,$2,1,$3,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '2 days')`,
      [expiredId,studentId,expiredDigest]);
      await expect(store.validateSession({sessionId:expiredId,digest:expiredDigest})).resolves.toEqual({outcome:"invalid"});
    });

    it("touches last_seen only after five minutes and never moves it backward",async()=>{
      const studentId=await seed("last-seen@example.com"); const id=await challenge("last-seen@example.com","right");
      const {sessionId,bearer}=await consume(id,"right"); const digest=cryptography.digestSession(bearer);
      const initial=(await owner.query("SELECT last_seen_at FROM downtown_u_auth_sessions WHERE session_id=$1",[sessionId])).rows[0].last_seen_at as Date;
      await store.validateSession({sessionId,digest});
      expect((await owner.query("SELECT last_seen_at FROM downtown_u_auth_sessions WHERE session_id=$1",[sessionId])).rows[0].last_seen_at).toEqual(initial);
      await owner.query("ALTER TABLE downtown_u_auth_sessions DISABLE TRIGGER downtown_u_auth_sessions_immutable");
      try { await owner.query(`UPDATE downtown_u_auth_sessions SET issued_at=issued_at-interval '6 minutes',last_seen_at=last_seen_at-interval '6 minutes' WHERE session_id=$1`,[sessionId]); }
      finally { await owner.query("ALTER TABLE downtown_u_auth_sessions ENABLE TRIGGER downtown_u_auth_sessions_immutable"); }
      const old=(await owner.query("SELECT last_seen_at FROM downtown_u_auth_sessions WHERE session_id=$1",[sessionId])).rows[0].last_seen_at as Date;
      await store.validateSession({sessionId,digest}); const advanced=(await owner.query("SELECT last_seen_at FROM downtown_u_auth_sessions WHERE session_id=$1",[sessionId])).rows[0].last_seen_at as Date;
      expect(advanced.getTime()).toBeGreaterThan(old.getTime()); await store.validateSession({sessionId,digest});
      expect((await owner.query("SELECT last_seen_at FROM downtown_u_auth_sessions WHERE session_id=$1",[sessionId])).rows[0].last_seen_at).toEqual(advanced);
      expect(advanced.getTime()).toBeGreaterThanOrEqual(initial.getTime()); expect(studentId).toBeTruthy();
    });

    it("persists only 32-byte digests and no plaintext verifier, OTP, or bearer",async()=>{
      const magic="MAGIC_PLAINTEXT_DO_NOT_STORE_6c93"; const otp="839271"; const bearer="BEARER_PLAINTEXT_DO_NOT_STORE_a14f";
      await seed("secrets@example.com","approved","+14155550999"); const emailId=await challenge("secrets@example.com",magic);
      const phoneId=await challenge("+14155550999",otp,"phone");
      await store.consumeChallenge({challengeId:emailId,digest:cryptography.digestChallenge(magic),sessionId:generateOpaqueId(),sessionDigest:cryptography.digestSession(bearer)});
      const rows=await owner.query(`SELECT verifier_digest AS digest FROM downtown_u_auth_challenges WHERE challenge_id IN ($1,$2)
        UNION ALL SELECT token_digest FROM downtown_u_auth_sessions WHERE token_digest=$3`,[emailId,phoneId,cryptography.digestSession(bearer)]);
      expect(rows.rows).toHaveLength(3); expect(rows.rows.every((row)=>Buffer.isBuffer(row.digest)&&row.digest.length===32)).toBe(true);
      const serialized=JSON.stringify((await owner.query(`SELECT challenge_id,normalized_contact,method,encode(verifier_digest,'hex') digest FROM downtown_u_auth_challenges
        WHERE challenge_id IN ($1,$2)` ,[emailId,phoneId])).rows)+JSON.stringify((await owner.query(`SELECT session_id,encode(token_digest,'hex') digest FROM downtown_u_auth_sessions WHERE token_digest=$1`,[cryptography.digestSession(bearer)])).rows);
      for(const secret of [magic,otp,bearer,Buffer.from(magic).toString("hex"),Buffer.from(otp).toString("hex"),Buffer.from(bearer).toString("hex")]) expect(serialized).not.toContain(secret);
    });
  });

  describe("runtime denial, owner immutability, and exact-schema preflight",()=>{
    it("denies every direct auth-table operation and all privilege-escalation DDL to runtime",async()=>{
      await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
      const denied=[
        "SELECT * FROM downtown_u_auth_challenges","INSERT INTO downtown_u_auth_challenges DEFAULT VALUES","UPDATE downtown_u_auth_challenges SET status='expired'","DELETE FROM downtown_u_auth_challenges","TRUNCATE downtown_u_auth_challenges",
        "SELECT * FROM downtown_u_auth_sessions","INSERT INTO downtown_u_auth_sessions DEFAULT VALUES","UPDATE downtown_u_auth_sessions SET revoked_at=now()","DELETE FROM downtown_u_auth_sessions","TRUNCATE downtown_u_auth_sessions",
        "SELECT downtown_u_auth_protect_challenge()","SELECT downtown_u_auth_protect_session()",
        "ALTER TABLE downtown_u_auth_challenges DISABLE TRIGGER ALL","ALTER TABLE downtown_u_auth_sessions DISABLE TRIGGER ALL",
        "CREATE OR REPLACE FUNCTION downtown_u_auth_protect_challenge() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
        "GRANT SELECT ON downtown_u_auth_challenges TO PUBLIC",
      ];
      for(const sql of denied) await expect(runtime.query(sql)).rejects.toSatisfy((error)=>code(error)==="42501");
    });

    it("has only the fixed-policy capability signatures and no nullable legacy overload bypass",async()=>{
      const rows=(await owner.query(`SELECT proname,pg_get_function_identity_arguments(oid) AS args
        FROM pg_proc WHERE pronamespace='public'::regnamespace
          AND proname IN ('downtown_u_create_auth_challenge','downtown_u_consume_auth_challenge')
        ORDER BY proname`)).rows;
      expect(rows).toEqual([
        {proname:"downtown_u_consume_auth_challenge",args:"requested_challenge_id text, requested_version smallint, requested_digest bytea, requested_session_id text, requested_session_version smallint, requested_session_digest bytea"},
        {proname:"downtown_u_create_auth_challenge",args:"requested_challenge_id text, requested_contact_type text, requested_contact text, requested_method text, requested_version smallint, requested_digest bytea"},
      ]);
      await expect(runtime.query(`SELECT * FROM downtown_u_create_auth_challenge(
        $1::text,$2::text,$3::text,$4::text,$5::smallint,$6::bytea,$7::integer,$8::smallint,$9::integer,$10::integer,$11::integer)`,
      [generateOpaqueId(),"email","legacy@example.com","email_magic_link",1,Buffer.alloc(32),null,null,null,null,null]))
        .rejects.toSatisfy((error)=>code(error)==="42883");
      await expect(runtime.query(`SELECT * FROM downtown_u_consume_auth_challenge(
        $1::text,$2::smallint,$3::bytea,$4::text,$5::smallint,$6::bytea,$7::integer)`,
      [generateOpaqueId(),1,Buffer.alloc(32),generateOpaqueId(),1,Buffer.alloc(32),null]))
        .rejects.toSatisfy((error)=>code(error)==="42883");
    });

    it("prevents owner updates to representative immutable fields, deletes, and both truncates",async()=>{
      const studentId=await seed("owner-protection@example.com"); const id=await challenge("owner-protection@example.com","right");
      const sessionId=generateOpaqueId(); await owner.query(`INSERT INTO downtown_u_auth_sessions(session_id,student_id,verifier_version,token_digest,expires_at)
        VALUES($1,$2,1,$3,clock_timestamp()+interval '1 day')`,[sessionId,studentId,cryptography.digestSession("owner-token")]);
      for(const sql of [
        `UPDATE downtown_u_auth_challenges SET verifier_digest=decode(repeat('ff',32),'hex') WHERE challenge_id='${id}'`,
        `UPDATE downtown_u_auth_challenges SET created_at=created_at-interval '1 second' WHERE challenge_id='${id}'`,
        `UPDATE downtown_u_auth_sessions SET token_digest=decode(repeat('ee',32),'hex') WHERE session_id='${sessionId}'`,
        `UPDATE downtown_u_auth_sessions SET last_seen_at=last_seen_at-interval '1 second' WHERE session_id='${sessionId}'`,
        `DELETE FROM downtown_u_auth_challenges WHERE challenge_id='${id}'`,`DELETE FROM downtown_u_auth_sessions WHERE session_id='${sessionId}'`,
        "TRUNCATE downtown_u_auth_challenges","TRUNCATE downtown_u_auth_sessions",
      ]) await expect(owner.query(sql)).rejects.toSatisfy((error)=>code(error)==="P0001");
    });

    it("rejects and recovers from capability, function, trigger, ACL, and RLS drift on the same pool",async()=>{
      await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
      await drift(`GRANT EXECUTE ON FUNCTION downtown_u_auth_protect_challenge() TO downtown_u_runtime`,`REVOKE EXECUTE ON FUNCTION downtown_u_auth_protect_challenge() FROM downtown_u_runtime`);
      await drift(`GRANT EXECUTE ON FUNCTION downtown_u_create_auth_challenge${createSignature} TO PUBLIC`,`REVOKE EXECUTE ON FUNCTION downtown_u_create_auth_challenge${createSignature} FROM PUBLIC`);
      await drift(`ALTER FUNCTION downtown_u_create_auth_challenge${createSignature} SET search_path=public`,`ALTER FUNCTION downtown_u_create_auth_challenge${createSignature} SET search_path=pg_catalog`);
      await drift(`ALTER FUNCTION downtown_u_consume_auth_challenge${consumeSignature} SECURITY INVOKER`,`ALTER FUNCTION downtown_u_consume_auth_challenge${consumeSignature} SECURITY DEFINER`);
      await drift("ALTER TABLE downtown_u_auth_challenges DISABLE TRIGGER downtown_u_auth_challenges_immutable","ALTER TABLE downtown_u_auth_challenges ENABLE TRIGGER downtown_u_auth_challenges_immutable");
      await drift("GRANT SELECT ON downtown_u_auth_challenges TO PUBLIC","REVOKE SELECT ON downtown_u_auth_challenges FROM PUBLIC");
      await drift("GRANT SELECT ON downtown_u_webhook_events TO downtown_u_runtime","REVOKE SELECT ON downtown_u_webhook_events FROM downtown_u_runtime");
      await drift("GRANT UPDATE(verifier_digest) ON downtown_u_auth_challenges TO downtown_u_runtime","REVOKE UPDATE(verifier_digest) ON downtown_u_auth_challenges FROM downtown_u_runtime");
      await drift("ALTER TABLE downtown_u_auth_sessions ENABLE ROW LEVEL SECURITY","ALTER TABLE downtown_u_auth_sessions DISABLE ROW LEVEL SECURITY");
    });

    it("fingerprints and rejects body drift in every auth capability and trigger helper",async()=>{
      const bodies:[string,string][]=[
        ["public.downtown_u_auth_protect_challenge()","BEGIN RETURN NEW; END"],
        ["public.downtown_u_auth_protect_session()","BEGIN RETURN NEW; END"],
        ["public.downtown_u_create_auth_challenge(text,text,text,text,smallint,bytea)",
          "BEGIN RETURN QUERY SELECT 'accepted'::text,NULL::text,NULL::timestamptz; END"],
        ["public.downtown_u_consume_auth_challenge(text,smallint,bytea,text,smallint,bytea)",
          "BEGIN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::uuid,NULL::timestamptz; END"],
        ["public.downtown_u_validate_auth_session(text,smallint,bytea)",
          "BEGIN RETURN QUERY SELECT 'invalid'::text,NULL::uuid,NULL::text,NULL::integer,NULL::timestamptz; END"],
        ["public.downtown_u_revoke_auth_session(text,smallint,bytea)",
          "BEGIN RETURN QUERY SELECT 'accepted'::text; END"],
      ];
      for(const [signature,body] of bodies) await driftFunctionBody(signature,body);
    });

    it("fingerprints execution-attribute drift while preserving function OID",async()=>{
      // Exercise CREATE OR REPLACE-compatible pg_proc attributes.
      await drift(`ALTER FUNCTION downtown_u_create_auth_challenge${createSignature} STABLE`,
        `ALTER FUNCTION downtown_u_create_auth_challenge${createSignature} VOLATILE`);
      await drift(`ALTER FUNCTION downtown_u_validate_auth_session(text,smallint,bytea) STRICT`,
        `ALTER FUNCTION downtown_u_validate_auth_session(text,smallint,bytea) CALLED ON NULL INPUT`);
      await drift(`ALTER FUNCTION downtown_u_revoke_auth_session(text,smallint,bytea) PARALLEL SAFE`,
        `ALTER FUNCTION downtown_u_revoke_auth_session(text,smallint,bytea) PARALLEL UNSAFE`);
    });

    it("rejects and recovers from rewrite-rule and relhasrules drift on the same pool",async()=>{
      await owner.query("CREATE RULE downtown_u_auth_sessions_intruder AS ON UPDATE TO downtown_u_auth_sessions DO ALSO NOTHING");
      try {
        expect((await owner.query(`SELECT relhasrules,
          (SELECT count(*)::int FROM pg_rewrite WHERE ev_class=c.oid) AS rule_count
          FROM pg_class c WHERE c.oid='downtown_u_auth_sessions'::regclass`)).rows[0])
          .toEqual({relhasrules:true,rule_count:1});
        await expectPreflightRejects();
        await expect(store.validateSession({sessionId:generateOpaqueId(),digest:Buffer.alloc(32)}))
          .rejects.toMatchObject({name:"AuthStoreError"});
      } finally {
        await owner.query("DROP RULE downtown_u_auth_sessions_intruder ON downtown_u_auth_sessions");
      }
      expect((await owner.query(`SELECT relhasrules,
        (SELECT count(*)::int FROM pg_rewrite WHERE ev_class=c.oid) AS rule_count
        FROM pg_class c WHERE c.oid='downtown_u_auth_sessions'::regclass`)).rows[0])
        .toEqual({relhasrules:true,rule_count:0});
      await expectPreflightRejects();
      await owner.query("VACUUM downtown_u_auth_sessions");
      expect((await owner.query(`SELECT relhasrules,
        (SELECT count(*)::int FROM pg_rewrite WHERE ev_class=c.oid) AS rule_count
        FROM pg_class c WHERE c.oid='downtown_u_auth_sessions'::regclass`)).rows[0])
        .toEqual({relhasrules:false,rule_count:0});
      await expect(assertDowntownURuntimeIdentity(runtime)).resolves.toBeUndefined();
    });

    it("rejects and recovers from columns, indexes, constraints, defaults, nullability, and digest-check drift",async()=>{
      await drift("ALTER TABLE downtown_u_auth_sessions ADD COLUMN intruder text","ALTER TABLE downtown_u_auth_sessions DROP COLUMN intruder");
      await drift("CREATE INDEX downtown_u_auth_sessions_intruder ON downtown_u_auth_sessions(issued_at)","DROP INDEX downtown_u_auth_sessions_intruder");
      await drift("ALTER TABLE downtown_u_auth_sessions ADD CONSTRAINT downtown_u_auth_sessions_intruder CHECK (true)","ALTER TABLE downtown_u_auth_sessions DROP CONSTRAINT downtown_u_auth_sessions_intruder");
      await drift("DROP INDEX downtown_u_auth_challenges_one_active; CREATE INDEX downtown_u_auth_challenges_one_active ON downtown_u_auth_challenges(contact_type,normalized_contact,method) WHERE status='active'",
        "DROP INDEX downtown_u_auth_challenges_one_active; CREATE UNIQUE INDEX downtown_u_auth_challenges_one_active ON downtown_u_auth_challenges(contact_type,normalized_contact,method) WHERE status='active'");
      await drift("DROP INDEX downtown_u_auth_challenges_one_active; CREATE UNIQUE INDEX downtown_u_auth_challenges_one_active ON downtown_u_auth_challenges(contact_type,normalized_contact,method) WHERE status='active' AND challenge_id IS NOT NULL",
        "DROP INDEX downtown_u_auth_challenges_one_active; CREATE UNIQUE INDEX downtown_u_auth_challenges_one_active ON downtown_u_auth_challenges(contact_type,normalized_contact,method) WHERE status='active'");
      await drift("ALTER TABLE downtown_u_auth_challenges ALTER COLUMN attempt_count SET DEFAULT 1","ALTER TABLE downtown_u_auth_challenges ALTER COLUMN attempt_count SET DEFAULT 0");
      await drift("ALTER TABLE downtown_u_auth_sessions ALTER COLUMN last_seen_at DROP NOT NULL","ALTER TABLE downtown_u_auth_sessions ALTER COLUMN last_seen_at SET NOT NULL");
      await drift("ALTER TABLE downtown_u_auth_sessions DROP CONSTRAINT downtown_u_auth_sessions_token_digest_check; ALTER TABLE downtown_u_auth_sessions ADD CONSTRAINT downtown_u_auth_sessions_token_digest_check CHECK (octet_length(token_digest)>=16)",
        "ALTER TABLE downtown_u_auth_sessions DROP CONSTRAINT downtown_u_auth_sessions_token_digest_check; ALTER TABLE downtown_u_auth_sessions ADD CONSTRAINT downtown_u_auth_sessions_token_digest_check CHECK (octet_length(token_digest)=32)");
    });

    it("rejects and recovers from an extra Downtown U function overload and relation",async()=>{
      await drift("CREATE FUNCTION downtown_u_validate_auth_session(integer) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN RETURN $1; END'",
        "DROP FUNCTION downtown_u_validate_auth_session(integer)");
      await drift("CREATE TABLE downtown_u_auth_intruder(id integer)","DROP TABLE downtown_u_auth_intruder");
    });
  });
});
