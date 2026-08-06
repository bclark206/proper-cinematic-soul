import { describe, expect, it, vi } from "vitest";
import { CheckoutRequestError } from "../../../server/downtown-u/checkout";
import { CheckoutRateLimitError } from "../../../server/downtown-u/postgres-checkout-store";
import { createCheckoutApi } from "../checkout";

const origin = "https://proper.example";
const env: NodeJS.ProcessEnv = {
  DOWNTOWN_U_CHECKOUT_ENABLED: "1", VERCEL: "1", VERCEL_ENV: "production", VERCEL_URL: "proper.example",
  DATABASE_URL: "postgres://unused", DOWNTOWN_U_AUTH_SECRET: "test-secret", DOWNTOWN_U_PUBLIC_APP_ORIGIN: origin,
  DOWNTOWN_U_SQUARE_APPLICATION_ID: "sq-app", SQUARE_LOCATION_ID: "LPPWSSV03BHK8", SQUARE_API_VERSION: "2026-01-22",
};
const attemptId = "11111111-1111-4111-8111-111111111111";
const valid = { planId: "flex-5", sourceId: "cnon:token", email: "student@example.edu", eligibilityConfirmed: true, idempotencyKey: "0123456789abcdef0123456789abcdef" };

type PublicState = "started"|"order_created"|"payment_created"|"paid"|"activated"|"operator_review"|"failed";
type Service = {
  checkout: ReturnType<typeof vi.fn<(input: Record<string, unknown>) => Promise<{attemptId:string;state:PublicState}>>>;
  status: ReturnType<typeof vi.fn<(id:string) => Promise<{state:PublicState}|null>>>;
};
function service(state: PublicState = "paid"): Service {
  return { checkout: vi.fn().mockResolvedValue({ attemptId, state }), status: vi.fn().mockResolvedValue({ state }) };
}
function request(options: { method?: string; headers?: Record<string,string|string[]|undefined>; body?: unknown; chunks?: unknown[]; ended?: boolean; query?: Record<string,string|string[]|undefined> } = {}) {
  return {
    method: options.method ?? "POST", headers: options.headers ?? {}, body: options.body, readableEnded: options.ended, query: options.query,
    async *[Symbol.asyncIterator]() { for (const chunk of options.chunks ?? []) yield chunk; },
  };
}
function response() {
  const headers = new Map<string,string>(); let status = 0; let body: unknown; let ended = false;
  const res = { setHeader: (k:string,v:string) => headers.set(k.toLowerCase(),v), status: (n:number) => { status=n; return { json: (v:unknown) => { body=v; }, end: () => { ended=true; } }; } };
  return { res, result: () => ({ headers, status, body, ended }) };
}
async function invoke(req: ReturnType<typeof request>, svc = service(), configOnly = false) {
  const output=response(); const factory=vi.fn(() => svc);
  await createCheckoutApi(env,configOnly,{service:factory})(req,output.res);
  return {...output.result(),svc,factory};
}
const postHeaders = { origin, "sec-fetch-site":"same-origin", "content-type":"application/json", "x-vercel-forwarded-for":"203.0.113.9" };
function security(result: Awaited<ReturnType<typeof invoke>>) {
  expect(Object.fromEntries(result.headers)).toMatchObject({
    "cache-control":"no-store, max-age=0", "content-security-policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy":"no-referrer", "x-content-type-options":"nosniff", "x-frame-options":"DENY",
  });
}

describe("Downtown U checkout API boundary",()=>{
  it.each([["paid",200],["activated",200],["operator_review",202],["failed",402]] as const)("maps exact %s result to %s",async(state,status)=>{
    const result=await invoke(request({headers:{...postHeaders,"content-length":String(JSON.stringify(valid).length)},chunks:[Buffer.from(JSON.stringify(valid))]}),service(state));
    expect(result.status).toBe(status); expect(result.body).toEqual({attemptId,state});
    expect(result.svc.checkout).toHaveBeenCalledWith({...valid,requestActor:expect.any(Buffer)}); security(result);
    expect(JSON.stringify(result.body)).not.toContain(valid.email);
  });

  it("accepts normal same-origin GET without Origin, validates the sole id, and returns status/not-found",async()=>{
    const svc=service("operator_review");
    const found=await invoke(request({method:"GET",headers:{"sec-fetch-site":"same-origin"},query:{id:attemptId}}),svc);
    expect(found.status).toBe(200); expect(found.body).toEqual({state:"operator_review"}); expect(svc.status).toHaveBeenCalledWith(attemptId); security(found);
    vi.mocked(svc.status).mockResolvedValueOnce(null);
    const missing=await invoke(request({method:"GET",headers:{"sec-fetch-site":"same-origin"},query:{id:attemptId}}),svc);
    expect(missing.status).toBe(404); expect(missing.body).toEqual({error:"not_found"});
  });

  it("serves config only as a bodyless same-origin GET with exact public properties",async()=>{
    const result=await invoke(request({method:"GET",headers:{"sec-fetch-site":"same-origin"}}),service(),true);
    expect(result.status).toBe(200); expect(result.body).toEqual({applicationId:"sq-app",locationId:"LPPWSSV03BHK8"});
    expect(result.factory).not.toHaveBeenCalled(); security(result);
    const wrong=await invoke(request({method:"POST",headers:postHeaders,chunks:[Buffer.from("{}")]}),service(),true);
    expect(wrong.status).toBe(405);
  });

  it("handles exact-origin same-origin OPTIONS without a body and does not wildcard CORS",async()=>{
    const result=await invoke(request({method:"OPTIONS",headers:{origin,"sec-fetch-site":"same-origin"}}));
    expect(result.status).toBe(204); expect(result.ended).toBe(true);
    expect(result.headers.get("access-control-allow-origin")).toBe(origin); expect([...result.headers.values()]).not.toContain("*"); security(result);
    const denied=await invoke(request({method:"OPTIONS",headers:{origin:"https://evil.example","sec-fetch-site":"cross-site"}}));
    expect(denied.status).toBe(403); expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  });

  it.each([
    ["missing Origin",{"sec-fetch-site":"same-origin","content-type":"application/json","x-vercel-forwarded-for":"203.0.113.9"}],
    ["wrong Origin",{...postHeaders,origin:"https://evil.example"}], ["cross-site",{...postHeaders,"sec-fetch-site":"cross-site"}],
    ["duplicate Origin",{...postHeaders,Origin:origin}], ["duplicate fetch metadata",{...postHeaders,"Sec-Fetch-Site":"same-origin"}],
  ])("rejects mutation with %s before reading or service creation",async(_label,headers)=>{
    const result=await invoke(request({headers,chunks:[Buffer.from(JSON.stringify(valid))]})); expect(result.status).toBe(403); expect(result.factory).not.toHaveBeenCalled(); security(result);
  });

  it.each([undefined,"text/plain","application/json, application/json","application/json; charset=latin1"])("rejects Content-Type %j",async(contentType)=>{
    const { "content-type": _contentType, ...withoutType }=postHeaders;
    const headers={...withoutType,...(contentType===undefined?{}:{"content-type":contentType})}; const result=await invoke(request({headers,chunks:[Buffer.from(JSON.stringify(valid))]}));
    expect(result.status).toBe(415); expect(result.factory).not.toHaveBeenCalled(); security(result);
  });

  it.each([
    ["pre-parsed body",{body:valid}], ["already-ended request",{ended:true}], ["malformed JSON",{chunks:[Buffer.from("{")]}],
    ["oversized declaration",{headers:{...postHeaders,"content-length":"4097"},chunks:[]}], ["oversized stream",{chunks:[Buffer.alloc(4097)]}],
    ["non-byte stream",{chunks:["private"]}], ["length mismatch",{headers:{...postHeaders,"content-length":"1"},chunks:[Buffer.from("{}")]}],
    ["extra property",{chunks:[Buffer.from(JSON.stringify({...valid,amount:1}))]}],
  ])("rejects %s as an invalid request",async(_label,extra)=>{
    const options=extra as {body?:unknown;ended?:boolean;chunks?:unknown[];headers?:Record<string,string>};
    const result=await invoke(request({...options,headers:options.headers??postHeaders})); expect(result.status).toBe(400); expect(result.body).toEqual({error:"invalid_request"}); security(result);
  });

  it.each([{}, {"x-vercel-forwarded-for":"203.0.113.9, 10.0.0.1"}, {"x-vercel-forwarded-for":"bad"}, {"x-vercel-forwarded-for":"203.0.113.9","X-Vercel-Forwarded-For":"203.0.113.9"}])("rejects missing or ambiguous trusted client IP",async(ip)=>{
    const { "x-vercel-forwarded-for": _ip, ...withoutIp }=postHeaders;
    const result=await invoke(request({headers:{...withoutIp,...ip},chunks:[Buffer.from(JSON.stringify(valid))]})); expect(result.status).toBe(400);
  });

  it("maps typed request/rate errors and hides all thrown details",async()=>{
    const invalid=service(); vi.mocked(invalid.checkout).mockRejectedValueOnce(new CheckoutRequestError());
    expect((await invoke(request({headers:postHeaders,chunks:[Buffer.from(JSON.stringify(valid))]}),invalid)).status).toBe(400);
    const limited=service(); vi.mocked(limited.checkout).mockRejectedValueOnce(new CheckoutRateLimitError());
    const rate=await invoke(request({headers:postHeaders,chunks:[Buffer.from(JSON.stringify(valid))]}),limited);
    expect(rate.status).toBe(429); expect(rate.headers.get("retry-after")).toBe("900"); expect(rate.body).toEqual({error:"temporarily_unavailable"});
    const broken=service(); vi.mocked(broken.checkout).mockRejectedValueOnce(new Error("student@example.edu square-secret"));
    const unavailable=await invoke(request({headers:postHeaders,chunks:[Buffer.from(JSON.stringify(valid))]}),broken);
    expect(unavailable.status).toBe(503); expect(JSON.stringify(unavailable.body)).not.toMatch(/student|square-secret/);
  });

  it.each([{}, {...env,DOWNTOWN_U_CHECKOUT_ENABLED:"true"}, {...env,VERCEL_ENV:"development"}, {...env,DOWNTOWN_U_PUBLIC_APP_ORIGIN:"http://proper.example"}, {...env,SQUARE_API_VERSION:"2026-01-21"}, {...env,SQUARE_API_VERSION:"2026-01-23"}])("fails closed for disabled or malformed environment",async(badEnv)=>{
    const output=response(); await createCheckoutApi(badEnv as NodeJS.ProcessEnv,false,{service:()=>service()})(request(),output.res);
    expect(output.result().status).toBe(503); expect(output.result().body).toEqual({error:"temporarily_unavailable"});
    expect(Object.fromEntries(output.result().headers)).toHaveProperty("cache-control","no-store, max-age=0");
  });

  it.each(["PUT","PATCH","DELETE","HEAD"])("rejects unsupported %s",async(method)=>{const result=await invoke(request({method,headers:postHeaders}));expect(result.status).toBe(405);security(result);});
});
