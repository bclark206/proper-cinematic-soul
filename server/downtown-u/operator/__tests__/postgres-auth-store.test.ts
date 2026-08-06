import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  OperatorAuthStoreError, PostgresOperatorAuthStore, operatorDatabasePoolConfig,
} from "../postgres-auth-store";
import { assertDowntownUOperatorRuntimeIdentity } from "../postgres-runtime-identity";

const id="123e4567-e89b-42d3-a456-426614174000";
const id2="223e4567-e89b-42d3-a456-426614174000";
const id3="323e4567-e89b-42d3-a456-426614174000";
const digest=Buffer.alloc(32,7);
const correlationId="operator-auth:123e4567-e89b-42d3-a456-426614174000";
function harness(row: Record<string,unknown>, rowCount: number|null=1) {
  const queries: Array<{sql:string;params?:unknown[]}> = [];
  const query=vi.fn(async (sql:string,params?:unknown[]) => {
    queries.push({sql,params});
    if (sql==="BEGIN" || sql==="COMMIT" || sql==="ROLLBACK") return { rowCount:null,rows:[] };
    if (sql==="PREFLIGHT") return { rowCount:1,rows:[{safe_operator_identity:true}] };
    return {rowCount,rows:[row]};
  });
  const release=vi.fn();
  const client={query,release} as unknown as PoolClient;
  const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
  const preflight=vi.fn(async(c:{query:(sql:string,params?:unknown[])=>Promise<unknown>})=>{ await c.query("PREFLIGHT"); });
  return { store:new PostgresOperatorAuthStore(pool,preflight),queries,query,release,preflight };
}

describe("PostgresOperatorAuthStore",()=>{
  it("uses one client transaction, preflight, exact begin capability and positional parameters",async()=>{
    const expiry=new Date(); const h=harness({outcome:"accepted",email_challenge_id:id2,expires_at:expiry});
    await expect(h.store.begin({flowId:id,normalizedEmail:"operator@example.test",version:1,flowDigest:digest,
      emailChallengeId:id2,emailChallengeDigest:digest,correlationId})).resolves.toEqual({outcome:"accepted",emailChallengeId:id2,expiresAt:expiry});
    expect(h.queries.map(x=>x.sql)).toEqual(["BEGIN","PREFLIGHT",expect.stringContaining("public.downtown_u_operator_auth_begin"),"COMMIT"]);
    expect(h.queries[2].params).toEqual([id,"operator@example.test",1,digest,id2,digest,correlationId]);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("rolls back on preflight and malformed/extra/buffer-bearing rows",async()=>{
    for (const row of [
      {outcome:"accepted",email_challenge_id:id2,expires_at:new Date(),extra:"no"},
      {outcome:"accepted",email_challenge_id:id2,expires_at:digest},
      {outcome:"other",email_challenge_id:null,expires_at:null},
    ]) {
      const h=harness(row);
      await expect(h.store.begin({flowId:id,normalizedEmail:"a@b.test",version:1,flowDigest:digest,emailChallengeId:id2,emailChallengeDigest:digest,correlationId}))
        .rejects.toBeInstanceOf(OperatorAuthStoreError);
      expect(h.queries.at(-1)?.sql).toBe("ROLLBACK"); expect(h.queries.some(x=>x.sql==="COMMIT")).toBe(false);
    }
    const h=harness({}); h.preflight.mockRejectedValueOnce(new Error("unsafe"));
    await expect(h.store.revoke({sessionId:id,sessionVersion:1,sessionDigest:digest,correlationId})).rejects.toBeInstanceOf(OperatorAuthStoreError);
    expect(h.queries.map(x=>x.sql)).toEqual(["BEGIN","ROLLBACK"]);
  });

  it("calls all remaining six exact signatures and validates bounded outcomes",async()=>{
    const now=new Date();
    const cases=[
      ["verifyEmail",{flowId:id,flowVersion:1,flowDigest:digest,emailChallengeId:id2,emailChallengeVersion:1,emailChallengeDigest:digest,smsChallengeId:id3,smsChallengeVersion:1,smsChallengeDigest:digest,correlationId},
        {outcome:"invalid",sms_challenge_id:null,normalized_phone:null,expires_at:null},"auth_verify_email"],
      ["finishSignIn",{flowId:id,flowVersion:1,flowDigest:digest,smsChallengeId:id2,smsChallengeVersion:1,smsChallengeDigest:digest,sessionId:id3,sessionVersion:1,sessionDigest:digest,correlationId},
        {outcome:"invalid",session_id:null,operator_id:null,display_name:null,role_codes:null,absolute_expires:null,idle_expires:null},"auth_finish_sign_in"],
      ["validateSession",{sessionId:id,sessionVersion:1,sessionDigest:digest,roleCode:null,gateCode:"read",correlationId},
        {outcome:"invalid",operator_id:null,display_name:null,role_codes:null,gate_code:null,absolute_expires_at:null,idle_expires_at:null,reauthenticated_at:null},"auth_validate_session"],
      ["beginReauth",{sessionId:id,sessionVersion:1,sessionDigest:digest,challengeId:id2,challengeVersion:1,challengeDigest:digest,correlationId},
        {outcome:"invalid",challenge_id:null,normalized_phone:null,expires_at:null},"auth_begin_reauth"],
      ["finishReauth",{sessionId:id,sessionVersion:1,sessionDigest:digest,challengeId:id2,challengeVersion:1,challengeDigest:digest,correlationId},
        {outcome:"reauthenticated",reauthenticated_at:now},"auth_finish_reauth"],
      ["revoke",{sessionId:id,sessionVersion:1,sessionDigest:digest,correlationId},{outcome:"accepted"},"auth_revoke_session"],
    ] as const;
    for (const [method,input,row,signature] of cases) {
      const h=harness(row); await (h.store[method] as (x:never)=>Promise<unknown>)(input as never);
      expect(h.queries[2].sql).toContain(signature); expect(h.queries.map(x=>x.sql).at(-1)).toBe("COMMIT");
    }
  });

  it("fails closed before SQL for malformed UUID/version/digest and never leaks secrets in errors",async()=>{
    const h=harness({outcome:"accepted"});
    await expect(h.store.revoke({sessionId:"bad",sessionVersion:1,sessionDigest:digest,correlationId})).resolves.toEqual({outcome:"accepted"});
    expect(h.query).not.toHaveBeenCalled();
    const failed=harness({}); failed.query.mockImplementationOnce(async()=>{throw new Error(digest.toString("hex"));});
    try { await failed.store.revoke({sessionId:id,sessionVersion:1,sessionDigest:digest,correlationId}); } catch(e) {
      expect(String(e)).not.toContain(digest.toString("hex"));
    }
  });
});

describe("operator identity and pool configuration",()=>{
  it("requires exactly one true attestation row",async()=>{
    await expect(assertDowntownUOperatorRuntimeIdentity({query:vi.fn(async()=>({rowCount:1,rows:[{safe_operator_identity:true}]}))} as never)).resolves.toBeUndefined();
    for (const rows of [[],[{safe_operator_identity:false}],[{safe_operator_identity:true},{safe_operator_identity:true}]])
      await expect(assertDowntownUOperatorRuntimeIdentity({query:vi.fn(async()=>({rowCount:rows.length,rows}))} as never)).rejects.toThrow("Unsafe Downtown U operator database identity");
  });
  it("uses only the dedicated credential and bounded pool settings",()=>{
    const url="postgresql://operator:p%40ss%3Aword@db.example.test/operator?sslmode=verify-full&channel_binding=require";
    expect(operatorDatabasePoolConfig({DOWNTOWN_U_OPERATOR_DATABASE_URL:url,DATABASE_URL:"postgresql://wrong:wrong@wrong/wrong"} as never))
      .toEqual({connectionString:url,max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,allowExitOnIdle:true});
    for (const value of [undefined,"https://u:p@example.test/db","postgresql://example.test/db",
      "postgresql://u:p@example.test/db","postgresql://u:p@example.test/db#sslmode=verify-full&channel_binding=require",
      "postgresql://u:p@example.test/db?options=-csearch_path%3Devil",
      "postgresql://u:p@example.test/db?sslmode=disable&channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=require&channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=verify-ca&channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=verify-full",
      "postgresql://u:p@example.test/db?channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=verify-full&sslmode=disable&channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=disable&sslmode=verify-full&channel_binding=require",
      "postgresql://u:p@example.test/db?sslmode=verify-full&channel_binding=require&channel_binding=disable",
      "postgresql://u:p@example.test/db?sslmode=verify-full&channel_binding=disable&channel_binding=require"])
      expect(()=>operatorDatabasePoolConfig({DOWNTOWN_U_OPERATOR_DATABASE_URL:value} as never)).toThrow();
  });
});
