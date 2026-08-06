import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { isUint8Array } from "node:util/types";
import { Pool } from "pg";
import { CheckoutRequestError, createCheckoutService, DOWNTOWN_U_LOCATION_ID, type CheckoutState } from "../../server/downtown-u/checkout";
import { readDowntownUSquareConfig } from "../../server/downtown-u/enrollment-service";
import { CheckoutRateLimitError, PostgresCheckoutStore } from "../../server/downtown-u/postgres-checkout-store";
import { createSquareClientFromEnv, SQUARE_API_VERSION } from "../../server/downtown-u/square-client";

export const config = { api: { bodyParser: false } };
const MAX_BODY = 4096;
type Req = AsyncIterable<unknown> & { method?: string; headers: Record<string,string|string[]|undefined>; body?: unknown; readableEnded?: boolean; query?: Record<string,string|string[]|undefined> };
type Res = { setHeader(k:string,v:string):void; status(n:number):{json(v:unknown):void;end?():void} };
type Service = { checkout(input: { planId:unknown; sourceId:unknown; email:unknown; eligibilityConfirmed:unknown; idempotencyKey:unknown; requestActor:Buffer }): Promise<{attemptId:string;state:CheckoutState}>; status(id:string):Promise<{state:CheckoutState}|null> };
type ApiOptions = { service?: () => Service };
const securityHeaders = { "Cache-Control":"no-store, max-age=0", "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'", "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff", "X-Frame-Options":"DENY" };
function send(res:Res,status:number,body:unknown,allowedOrigin?:string){ for(const [k,v] of Object.entries(securityHeaders))res.setHeader(k,v); if(allowedOrigin){res.setHeader("Access-Control-Allow-Origin",allowedOrigin);res.setHeader("Vary","Origin");} if(status===204){res.status(status).end?.();return;} res.setHeader("Content-Type","application/json; charset=utf-8");res.status(status).json(body); }
function ownString(object: Record<string, unknown>, key: string): string|undefined { const d=Object.getOwnPropertyDescriptor(object,key);return d&&"value" in d&&typeof d.value==="string"?d.value:undefined; }
function exactHeader(req:Req,name:string):string|undefined { const keys=Object.keys(req.headers).filter(k=>k.toLowerCase()===name); if(keys.length!==1)return; return ownString(req.headers,keys[0]); }
function publicOrigin(env:NodeJS.ProcessEnv):string { const value=env.DOWNTOWN_U_PUBLIC_APP_ORIGIN??""; const u=new URL(value); if(u.protocol!=="https:"||u.origin!==value||u.pathname!=="/"||u.username||u.password)throw new Error(); return value; }
function enabled(env:NodeJS.ProcessEnv): {origin:string;applicationId:string} {
  if(env.DOWNTOWN_U_CHECKOUT_ENABLED!=="1"||env.VERCEL!=="1"||!env.DATABASE_URL||!env.DOWNTOWN_U_AUTH_SECRET)throw new Error();
  if(!/^(production|preview)$/.test(env.VERCEL_ENV??"")||!/^[A-Za-z0-9.-]+$/.test(env.VERCEL_URL??""))throw new Error();
  const origin=publicOrigin(env), applicationId=env.DOWNTOWN_U_SQUARE_APPLICATION_ID??"";
  if(!/^[A-Za-z0-9_-]{1,192}$/.test(applicationId)||env.SQUARE_LOCATION_ID!==DOWNTOWN_U_LOCATION_ID||env.SQUARE_API_VERSION!==SQUARE_API_VERSION)throw new Error(); return {origin,applicationId};
}
function readProtocol(req:Req,origin:string):boolean { const site=exactHeader(req,"sec-fetch-site");const supplied=exactHeader(req,"origin");return site==="same-origin"&&(supplied===undefined||supplied===origin); }
function writeProtocol(req:Req,origin:string):boolean { return exactHeader(req,"sec-fetch-site")==="same-origin"&&exactHeader(req,"origin")===origin; }
function emptyRequest(req:Req):boolean { if(req.body!==undefined)return false;const length=exactHeader(req,"content-length");return (length===undefined||length==="0")&&exactHeader(req,"transfer-encoding")===undefined; }
function jsonContentType(value:string|undefined):boolean { if(value===undefined)return false;const match=/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.exec(value);return match!==null; }
async function raw(req:Req):Promise<unknown>{
  if(req.body!==undefined||req.readableEnded)return undefined;
  const declared=exactHeader(req,"content-length");if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))return undefined;
  let n=0;const chunks:Buffer[]=[];for await(const c of req){if(!isUint8Array(c))return undefined;const b=Buffer.from(c.buffer,c.byteOffset,c.byteLength);n+=b.length;if(n>MAX_BODY)return undefined;chunks.push(b);}
  if(declared!==undefined&&Number(declared)!==n)return undefined;
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,n)));}catch{return undefined;}
}
function checkoutBody(value:unknown): {planId:unknown;sourceId:unknown;email:unknown;eligibilityConfirmed:unknown;idempotencyKey:unknown}|null {
  if(typeof value!=="object"||value===null||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return null;
  const expected=["eligibilityConfirmed","email","idempotencyKey","planId","sourceId"];
  if(Object.keys(value).sort().join("\0")!==expected.join("\0"))return null;
  const o=value as Record<string,unknown>;for(const key of expected){const d=Object.getOwnPropertyDescriptor(o,key);if(!d||!("value" in d))return null;}
  return {planId:o.planId,sourceId:o.sourceId,email:o.email,eligibilityConfirmed:o.eligibilityConfirmed,idempotencyKey:o.idempotencyKey};
}
function actor(req:Req,env:NodeJS.ProcessEnv):Buffer|null { const ip=exactHeader(req,"x-vercel-forwarded-for"),secret=env.DOWNTOWN_U_AUTH_SECRET;if(!ip||ip.trim()!==ip||ip.includes(",")||isIP(ip)===0||!secret)return null;return createHmac("sha256",secret).update(`checkout:${ip}`).digest(); }
let pool:Pool|undefined;function defaultService(env:NodeJS.ProcessEnv):Service { pool??=new Pool({connectionString:env.DATABASE_URL!,max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,allowExitOnIdle:true});const squareConfig=readDowntownUSquareConfig(env);return createCheckoutService({client:createSquareClientFromEnv(env),store:new PostgresCheckoutStore(pool),...squareConfig}); }

export function createCheckoutApi(env:NodeJS.ProcessEnv, configOnly=false, options:ApiOptions={}) { return async(req:Req,res:Res):Promise<void>=>{
  let gate:{origin:string;applicationId:string};try{gate=enabled(env);}catch{send(res,503,{error:"temporarily_unavailable"});return;}
  const allowOrigin=exactHeader(req,"origin")===gate.origin?gate.origin:undefined;
  if(req.method==="OPTIONS"){if(!writeProtocol(req,gate.origin)||!emptyRequest(req)){send(res,403,{error:"invalid_request"});return;}res.setHeader("Access-Control-Allow-Methods",configOnly?"GET, OPTIONS":"GET, POST, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");send(res,204,undefined,gate.origin);return;}
  if(configOnly){if(req.method!=="GET"){send(res,405,{error:"invalid_request"},allowOrigin);return;}if(!readProtocol(req,gate.origin)||!emptyRequest(req)){send(res,403,{error:"invalid_request"},allowOrigin);return;}send(res,200,{applicationId:gate.applicationId,locationId:DOWNTOWN_U_LOCATION_ID},allowOrigin);return;}
  try {
    if(req.method==="GET"){if(!readProtocol(req,gate.origin)||!emptyRequest(req)){send(res,403,{error:"invalid_request"},allowOrigin);return;}const id=typeof req.query?.id==="string"&&Object.keys(req.query).length===1?req.query.id:"";const service=(options.service??(()=>defaultService(env)))();const status=await service.status(id);send(res,status?200:404,status??{error:"not_found"},allowOrigin);return;}
    if(req.method!=="POST"){send(res,405,{error:"invalid_request"},allowOrigin);return;}
    if(!writeProtocol(req,gate.origin)){send(res,403,{error:"invalid_request"},allowOrigin);return;}
    if(!jsonContentType(exactHeader(req,"content-type"))){send(res,415,{error:"invalid_request"},gate.origin);return;}
    const parsed=checkoutBody(await raw(req)),requestActor=actor(req,env);if(!parsed||!requestActor){send(res,400,{error:"invalid_request"},gate.origin);return;}
    const service=(options.service??(()=>defaultService(env)))();
    const result=await service.checkout({...parsed,requestActor});const status=result.state==="paid"||result.state==="activated"?200:result.state==="failed"?402:202;send(res,status,result,gate.origin);
  } catch(error) { if(error instanceof CheckoutRequestError){send(res,400,{error:"invalid_request"},allowOrigin);return;}if(error instanceof CheckoutRateLimitError){res.setHeader("Retry-After","900");send(res,429,{error:"temporarily_unavailable"},allowOrigin);return;}send(res,503,{error:"temporarily_unavailable"},allowOrigin); }
}; }
export default createCheckoutApi(process.env);
