import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { createAuthPoolCache } from "../auth-handler";
import { validateStrongSecret } from "../../../server/downtown-u/auth";
import { createSquareClientFromEnv, type SquareCheckoutClient } from "../../../server/downtown-u/square-client";
import { PostgresKitchenJobStore } from "../../../server/downtown-u/postgres-kitchen-job-store";
import { runKitchenOrderBatch, type KitchenBatchResult } from "../../../server/downtown-u/kitchen-order-worker";
import type { NodePortalRequest,NodePortalResponse } from "../student-portal-handler";
export const config={api:{bodyParser:false},maxDuration:30};
const SECURITY={"Cache-Control":"private, no-store, max-age=0","Content-Type":"application/json; charset=utf-8","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"};
function send(r:NodePortalResponse,s:number,b:unknown){for(const [n,v] of Object.entries(SECURITY))r.setHeader(n,v);r.status(s).json(b)}
function ownString(o:object,n:string):string|undefined{const ks=Object.keys(o).filter(k=>k.toLowerCase()===n);if(ks.length!==1)return;const d=Object.getOwnPropertyDescriptor(o,ks[0]);return d&&"value" in d&&typeof d.value==="string"?d.value:undefined}
function headers(req:NodePortalRequest):Record<string,string|string[]|undefined>|null{const d=Object.getOwnPropertyDescriptor(req,"headers");return d&&"value" in d&&typeof d.value==="object"&&d.value!==null?d.value:null}
function has(o:object,n:string){return Object.keys(o).some(k=>k.toLowerCase()===n)}
function duplicate(req:NodePortalRequest){const d=Object.getOwnPropertyDescriptor(req,"rawHeaders");if(!d||!("value" in d)||d.value===undefined)return false;if(!Array.isArray(d.value)||d.value.length%2||d.value.some(v=>typeof v!=="string"))return true;let n=0;for(let i=0;i<d.value.length;i+=2)if(d.value[i].toLowerCase()==="authorization")n++;return n>1}
function authorized(h:string|undefined,s:string|undefined,compare:(a:Buffer,b:Buffer)=>boolean){if(typeof h!=="string"||h.length!==50||!h.startsWith("Bearer "))return false;try{return compare(validateStrongSecret(h.slice(7)),validateStrongSecret(s))}catch{return false}}
async function empty(req:NodePortalRequest){const b=Object.getOwnPropertyDescriptor(req,"body"),e=Object.getOwnPropertyDescriptor(req,"readableEnded");if(b&&(!("value" in b)||b.value!==undefined)||e&&(!("value" in e)||e.value===true))return false;for await(const chunk of req)if(!(chunk instanceof Uint8Array)||chunk.byteLength)return false;return true}
export interface KitchenJobBoundaries{getPool(url:string):Pool;square(env:NodeJS.ProcessEnv):SquareCheckoutClient;run(pool:Pool,square:SquareCheckoutClient):Promise<KitchenBatchResult>;compare(a:Buffer,b:Buffer):boolean}
const getPool=createAuthPoolCache();
const boundaries:KitchenJobBoundaries={getPool,square:createSquareClientFromEnv,compare:timingSafeEqual,run:(pool,square)=>runKitchenOrderBatch(new PostgresKitchenJobStore(pool),square,10,20_000)};
export function createKitchenOrdersHandler(env:NodeJS.ProcessEnv=process.env,b:KitchenJobBoundaries=boundaries){return async(req:NodePortalRequest,res:NodePortalResponse)=>{
 if(env.DOWNTOWN_U_PORTAL_ENABLED!=="1"||env.DOWNTOWN_U_KITCHEN_ORDERS_ENABLED!=="1"){send(res,503,{error:"unavailable"});return}
 const md=Object.getOwnPropertyDescriptor(req,"method");if(!md||!("value" in md)||md.value!=="GET"&&md.value!=="POST"){send(res,405,{error:"method_not_allowed"});return}
 const hs=headers(req),secret=env.CRON_SECRET;if(!hs||duplicate(req)||!authorized(ownString(hs,"authorization"),secret,b.compare)){send(res,401,{error:"unauthorized"});return}
 if(has(hs,"origin")||has(hs,"content-type")||has(hs,"transfer-encoding")||!await empty(req)){send(res,400,{error:"invalid_request"});return}
 const hasLength=has(hs,"content-length"),length=ownString(hs,"content-length");if(hasLength&&length!=="0"){send(res,400,{error:"invalid_request"});return}
 try{if(!env.DOWNTOWN_U_KITCHEN_DATABASE_URL)throw new Error("configuration");const square=b.square(env);if(square.locationId!=="LPPWSSV03BHK8")throw new Error("configuration");const result=await b.run(b.getPool(env.DOWNTOWN_U_KITCHEN_DATABASE_URL),square);if(!Number.isInteger(result.claimed)||!Number.isInteger(result.completed)||!Number.isInteger(result.deferred)||result.claimed<0||result.claimed>10||result.completed<0||result.deferred<0||result.completed+result.deferred!==result.claimed)throw new Error("invalid result");console.info("downtown_u_kitchen_job",{status:202,claimed:result.claimed,completed:result.completed,deferred:result.deferred});send(res,202,{accepted:true})}catch{console.error("downtown_u_kitchen_job",{status:503,claimed:0,completed:0,deferred:0});send(res,503,{error:"unavailable"})}
 }}
const handler=createKitchenOrdersHandler();export default (req:NodePortalRequest,res:NodePortalResponse)=>handler(req,res);
