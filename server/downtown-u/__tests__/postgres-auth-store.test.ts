import type { Pool,PoolClient } from "pg";
import { describe,expect,it,vi } from "vitest";
import { AuthStoreError,PostgresAuthStore } from "../postgres-auth-store";

function fake(row:Record<string,unknown>,failure?:unknown){
  const query=vi.fn(async(sql:string,_params?:unknown[])=>{if(["BEGIN","COMMIT","ROLLBACK","PREFLIGHT"].includes(sql))return {rows:[],rowCount:null};
    if(failure)throw failure; return {rows:[row],rowCount:1};});
  const client={query,release:vi.fn()} as unknown as PoolClient;
  const pool={query:vi.fn(async()=>({rows:[{safe_runtime_identity:true}]})),connect:vi.fn(async()=>client)} as unknown as Pool;
  const preflight=vi.fn(async(queryable:{query:(sql:string)=>Promise<unknown>})=>{await queryable.query("PREFLIGHT");});
  return {store:new PostgresAuthStore(pool,preflight),query,preflight,client,pool};
}
const digest=Buffer.alloc(32,1);

describe("PostgreSQL auth store boundary",()=>{
  it("pins preflight and capability to the same transaction client in exact order",async()=>{
    const value=fake({outcome:"accepted",challenge_id:null,expires_at:null});
    await value.store.createChallenge({challengeId:"A".repeat(43),contactType:"email",
      normalizedContact:"person@example.com",method:"email_magic_link",digest});
    expect(value.preflight).toHaveBeenCalledOnce();
    expect(value.preflight).toHaveBeenCalledWith(value.client);
    expect(value.query.mock.calls.map(([sql])=>sql)).toEqual([
      "BEGIN","PREFLIGHT",expect.stringContaining("downtown_u_create_auth_challenge"),"COMMIT",
    ]);
    expect(value.pool.query).not.toHaveBeenCalled();
  });

  it("rejects every malformed digest path generically without preflight or a query",async()=>{
    for(const malformed of [Buffer.alloc(0),Buffer.alloc(31),Buffer.alloc(33),"plaintext" as unknown as Buffer]) {
      const create=fake({});
      await expect(create.store.createChallenge({challengeId:"A".repeat(43),contactType:"email",
        normalizedContact:"person@example.com",method:"email_magic_link",digest:malformed})).resolves.toEqual({outcome:"accepted"});
      expect(create.preflight).not.toHaveBeenCalled(); expect(create.query).not.toHaveBeenCalled();
      const consume=fake({});
      await expect(consume.store.consumeChallenge({challengeId:"C".repeat(43),digest:malformed,
        sessionId:"S".repeat(43),sessionDigest:digest})).resolves.toEqual({outcome:"invalid"});
      await expect(consume.store.consumeChallenge({challengeId:"C".repeat(43),digest,
        sessionId:"S".repeat(43),sessionDigest:malformed})).resolves.toEqual({outcome:"invalid"});
      expect(consume.preflight).not.toHaveBeenCalled(); expect(consume.query).not.toHaveBeenCalled();
      const validate=fake({}); const revoke=fake({});
      await expect(validate.store.validateSession({sessionId:"S",digest:malformed})).resolves.toEqual({outcome:"invalid"});
      await expect(revoke.store.revokeSession({sessionId:"S",digest:malformed})).resolves.toEqual({outcome:"accepted"});
      expect(validate.preflight).not.toHaveBeenCalled(); expect(revoke.preflight).not.toHaveBeenCalled();
    }
  });

  it("maps known create conflicts to the same generic accepted outcome",async()=>{
    const value=fake({}, {code:"23505"});
    await expect(value.store.createChallenge({challengeId:"A".repeat(43),contactType:"email",
      normalizedContact:"person@example.com",method:"email_magic_link",digest})).resolves.toEqual({outcome:"accepted"});
    expect(value.preflight).toHaveBeenCalledOnce(); expect(value.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("retains an unknown internal cause without putting secrets in its public message",async()=>{
    const cause=new Error("driver disconnected"); const value=fake({},cause);
    const promise=value.store.validateSession({sessionId:"S".repeat(43),digest});
    await expect(promise).rejects.toBeInstanceOf(AuthStoreError);
    await expect(promise).rejects.toMatchObject({message:"Downtown U authentication storage failed",cause});
  });

  it("wraps unknown preflight failures while preserving their cause",async()=>{
    const value=fake({outcome:"invalid"}); const cause=new Error("catalog drift details");
    value.preflight.mockRejectedValueOnce(cause);
    const promise=value.store.validateSession({sessionId:"S".repeat(43),digest});
    await expect(promise).rejects.toMatchObject({
      name:"AuthStoreError",message:"Downtown U authentication storage failed",cause,
    });
    expect(value.query.mock.calls.map(([sql])=>sql)).toEqual(["BEGIN","ROLLBACK"]);
  });

  it("rejects an unsafe connected client before capability even when pool.query appears safe",async()=>{
    const value=fake({outcome:"invalid"}); const cause=Object.assign(new Error("unsafe connected identity"),{code:"P0001"});
    value.preflight.mockImplementationOnce(async(queryable)=>{
      expect(queryable).toBe(value.client); throw cause;
    });
    await expect(value.store.validateSession({sessionId:"S".repeat(43),digest})).rejects.toMatchObject({
      name:"AuthStoreError",message:"Downtown U authentication storage failed",cause,
    });
    expect(value.pool.query).not.toHaveBeenCalled();
    expect(value.query.mock.calls.map(([sql])=>sql)).toEqual(["BEGIN","ROLLBACK"]);
    expect(value.query.mock.calls.some(([sql])=>String(sql).includes("validate_auth_session"))).toBe(false);
  });

  it("maps invalid validation and revocation without exposing digest data",async()=>{
    await expect(fake({outcome:"invalid"}).store.validateSession({sessionId:"S".repeat(43),digest}))
      .resolves.toEqual({outcome:"invalid"});
    await expect(fake({outcome:"accepted"}).store.revokeSession({sessionId:"S".repeat(43),digest}))
      .resolves.toEqual({outcome:"accepted"});
  });

  it("uses one capability SELECT and passes digests, never plaintext verifiers",async()=>{
    const value=fake({outcome:"authenticated",session_id:"S".repeat(43),student_id:"student",
      expires_at:new Date("2026-08-06T00:00:00Z")});
    const sessionDigest=Buffer.alloc(32,2);
    await value.store.consumeChallenge({challengeId:"C".repeat(43),digest,sessionId:"S".repeat(43),sessionDigest});
    const capability=value.query.mock.calls.filter(([sql])=>String(sql).startsWith("SELECT * FROM public.downtown_u_"));
    expect(capability).toHaveLength(1); expect(capability[0][0]).toContain("consume_auth_challenge");
    expect(capability[0][0]).not.toContain("$7"); expect(capability[0][1]).toHaveLength(6);
    expect(JSON.stringify(capability[0])).not.toContain("otp");
  });

  it("passes no caller-controlled policy arguments to challenge creation",async()=>{
    const value=fake({outcome:"accepted",challenge_id:null,expires_at:null});
    await value.store.createChallenge({challengeId:"A".repeat(43),contactType:"email",
      normalizedContact:"person@example.com",method:"email_magic_link",digest});
    const capability=value.query.mock.calls.find(([sql])=>String(sql).includes("create_auth_challenge"));
    expect(capability?.[0]).not.toContain("$7"); expect(capability?.[1]).toHaveLength(6);
  });

  it.each([
    ["create",()=>fake({outcome:"accepted",challenge_id:"id",expires_at:"not-a-date"}).store.createChallenge({
      challengeId:"A".repeat(43),contactType:"email" as const,normalizedContact:"a@example.com",
      method:"email_magic_link" as const,digest})],
    ["consume",()=>fake({outcome:"authenticated",session_id:null,student_id:"student",expires_at:new Date()})
      .store.consumeChallenge({challengeId:"C".repeat(43),digest,sessionId:"S".repeat(43),sessionDigest:digest})],
    ["validate",()=>fake({outcome:"valid",student_id:"student",eligibility_status:"approved",
      credit_balance:"12",expires_at:new Date()}).store.validateSession({sessionId:"S".repeat(43),digest})],
    ["revoke",()=>fake({outcome:"unexpected"}).store.revokeSession({sessionId:"S".repeat(43),digest})],
  ] as const)("wraps malformed %s result shapes as internal storage failures",async(_name,run)=>{
    await expect(run()).rejects.toMatchObject({
      name:"AuthStoreError",message:"Downtown U authentication storage failed",
    });
  });
});
