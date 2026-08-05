import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { createAuthPoolCache } from "../auth-handler";
import { assertDowntownUJobRuntimeIdentity } from "../../../server/downtown-u/postgres-job-runtime-identity";
import { withPostgresTransaction } from "../../../server/downtown-u/postgres-transaction";
import { validateStrongSecret } from "../../../server/downtown-u/auth";
import type { NodePortalRequest,NodePortalResponse } from "../student-portal-handler";

export const config={api:{bodyParser:false}};
const SECURITY={"Cache-Control":"private, no-store, max-age=0","Content-Type":"application/json; charset=utf-8","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"};
function send(response:NodePortalResponse,status:number,body:unknown){for(const [name,value] of Object.entries(SECURITY))response.setHeader(name,value);response.status(status).json(body)}
function ownString(target:object,name:string):string|undefined{const keys=Object.keys(target).filter(key=>key.toLowerCase()===name);if(keys.length!==1)return undefined;const d=Object.getOwnPropertyDescriptor(target,keys[0]);return d&&"value" in d&&typeof d.value==="string"?d.value:undefined}
function requestHeaders(request:NodePortalRequest):Record<string,string|string[]|undefined>|null{const d=Object.getOwnPropertyDescriptor(request,"headers");return d&&"value" in d&&typeof d.value==="object"&&d.value!==null?d.value:null}
function hasHeader(target:object,name:string):boolean{return Object.keys(target).some(key=>key.toLowerCase()===name)}
function duplicateAuthorization(request:NodePortalRequest):boolean{const d=Object.getOwnPropertyDescriptor(request,"rawHeaders");if(!d||!("value" in d)||d.value===undefined)return false;if(!Array.isArray(d.value)||d.value.length%2!==0||d.value.some((v:unknown)=>typeof v!=="string"))return true;let count=0;for(let i=0;i<d.value.length;i+=2)if(d.value[i].toLowerCase()==="authorization")count++;return count>1}
function authorized(header:string|undefined,secret:string|undefined,compare:(a:Buffer,b:Buffer)=>boolean):boolean{if(typeof header!=="string"||header.length!==50||!header.startsWith("Bearer "))return false;try{const expected=validateStrongSecret(secret);const supplied=validateStrongSecret(header.slice(7));return compare(supplied,expected)}catch{return false}}
async function emptyRawBody(request:NodePortalRequest):Promise<boolean>{const body=Object.getOwnPropertyDescriptor(request,"body");const ended=Object.getOwnPropertyDescriptor(request,"readableEnded");if(body&&(!("value" in body)||body.value!==undefined)||ended&&(!("value" in ended)||ended.value===true))return false;for await(const chunk of request){if(!(chunk instanceof Uint8Array)||chunk.byteLength!==0)return false}return true}

export interface ExpiryJobBoundaries{getPool(url:string):Pool;run(pool:Pool,limit:number):Promise<number>;compare(a:Buffer,b:Buffer):boolean}
const getPool=createAuthPoolCache();
const boundaries:ExpiryJobBoundaries={getPool,compare:timingSafeEqual,run:async(pool,limit)=>withPostgresTransaction(pool,async client=>{await assertDowntownUJobRuntimeIdentity(client);const result=await client.query("SELECT public.downtown_u_reverse_expired_reservations($1::integer) AS reversed_count",[limit]);const row=result.rows[0];const value=row&&Object.getOwnPropertyDescriptor(row,"reversed_count");if(result.rowCount!==1||result.rows.length!==1||!row||Reflect.ownKeys(row).length!==1||!value||!("value" in value)||typeof value.value!=="number"||!Number.isInteger(value.value)||value.value<0||value.value>limit)throw new Error("invalid capability result");return value.value})};
export function createExpireReservationsHandler(env:NodeJS.ProcessEnv=process.env,b:ExpiryJobBoundaries=boundaries){return async(request:NodePortalRequest,response:NodePortalResponse)=>{
 if(env.DOWNTOWN_U_PORTAL_ENABLED!=="1"){send(response,503,{error:"unavailable"});return}
 const method=Object.getOwnPropertyDescriptor(request,"method");if(!method||!("value" in method)||method.value!=="POST"&&method.value!=="GET"){send(response,405,{error:"method_not_allowed"});return}
 const headers=requestHeaders(request);const secret=env.CRON_SECRET??env.DOWNTOWN_U_JOBS_SECRET;if(!headers||duplicateAuthorization(request)||!authorized(ownString(headers,"authorization"),secret,b.compare)){send(response,401,{error:"unauthorized"});return}
 if(hasHeader(headers,"origin")||hasHeader(headers,"content-type")||hasHeader(headers,"transfer-encoding")||!await emptyRawBody(request)){send(response,400,{error:"invalid_request"});return}
 const hasLength=hasHeader(headers,"content-length");const length=ownString(headers,"content-length");if(hasLength&&length!=="0"){send(response,400,{error:"invalid_request"});return}
 try{if(!env.DOWNTOWN_U_JOBS_DATABASE_URL)throw new Error("configuration");const count=await b.run(b.getPool(env.DOWNTOWN_U_JOBS_DATABASE_URL),100);if(typeof count!=="number"||!Number.isInteger(count)||count<0||count>100)throw new Error("invalid capability result");console.info("downtown_u_expiry_job",{status:202,count});send(response,202,{accepted:true})}catch{console.error("downtown_u_expiry_job",{status:503,count:0});send(response,503,{error:"unavailable"})}
}}
const handler=createExpireReservationsHandler();
export default (request:NodePortalRequest,response:NodePortalResponse)=>handler(request,response);
