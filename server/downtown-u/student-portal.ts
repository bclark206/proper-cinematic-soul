import type { AuthCryptography } from "./auth";
import type { AuthStore } from "./postgres-auth-store";

export const STUDENT_PORTAL_MAX_BODY_BYTES=8_192;
const COOKIE_NAME="downtown_u_session";
const OPAQUE=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY=/^[A-Za-z0-9_-]{16,96}$/;
export const STUDENT_PORTAL_SECURITY_HEADERS=Object.freeze({"Cache-Control":"private, no-store, max-age=0","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"});
export type PortalEndpoint="me"|"meals"|"purchases"|"reservations"|"reservation-cancel"|"logout";
export interface PortalRequest {method?:string;headers:Record<string,string|string[]|undefined>;body?:unknown;query?:Record<string,string|string[]|undefined>;reservationId?:string}
export interface PortalResponse {status:number;body?:unknown;headers:Record<string,string>}
export interface MealModifier {id:string;name:string;creditDelta:number}
export interface MealDefinition {id:string;name:string;baseCredits:number;modifiers:MealModifier[]}
export interface PortalReservation {id:string;mealId:string;mealName:string;modifiers:MealModifier[];credits:number;status:"reserved"|"redeemed"|"reversed";reservedAt:string;expiresAt:string;reversedAt?:string}
export interface PortalPrincipal {studentId:string;sessionId:string;digest:Buffer}
export interface StudentPortalStore {
 me(principal:PortalPrincipal):Promise<unknown>;
 meals(principal:PortalPrincipal):Promise<MealDefinition[]>;
 purchases(principal:PortalPrincipal,options?:{limit:number;cursor:string|null}):Promise<unknown>;
 reservations(principal:PortalPrincipal,options?:{limit:number;cursor:string|null}):Promise<unknown>;
 reserve(input:{principal:PortalPrincipal;mealId:string;modifierIds:string[];idempotencyKey:string}):Promise<PortalReservation>;
 reverse(input:{principal:PortalPrincipal;reservationId:string;idempotencyKey:string}):Promise<PortalReservation>;
}
export class PortalConflictError extends Error {}
export class PortalInsufficientCreditsError extends Error {}
export class PortalNotFoundError extends Error {}
export class PortalInvalidRequestError extends Error {}
export class PortalRateLimitError extends Error {}

/** Parses the raw Cookie header without normalization or accessor invocation. */
export function parseSessionCookie(raw:string|undefined):{sessionId:string;bearer:string}|null {
 if(typeof raw!=="string"||raw.length===0||raw.length>4096||Array.from(raw).some(character=>{const code=character.charCodeAt(0);return code<=31||code===127;})) return null;
 let value:string|undefined;
 for(const segment of raw.split(";")) {
  const part=segment.trim(); const equals=part.indexOf("="); if(equals<=0) return null;
  const name=part.slice(0,equals); if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
  if(name===COOKIE_NAME) { if(value!==undefined) return null; value=part.slice(equals+1); }
 }
 if(value===undefined) return null;
 const pieces=value.split(".");
 return pieces.length===3&&pieces[0]==="v1"&&OPAQUE.test(pieces[1])&&OPAQUE.test(pieces[2])?{sessionId:pieces[1],bearer:pieces[2]}:null;
}
function ownHeader(headers:PortalRequest["headers"],wanted:string):string|undefined {
 if(typeof headers!=="object"||headers===null)return undefined;
 const keys=Object.keys(headers).filter(k=>k.toLowerCase()===wanted); if(keys.length!==1)return undefined;
 const d=Object.getOwnPropertyDescriptor(headers,keys[0]); return d&&"value" in d&&typeof d.value==="string"?d.value:undefined;
}
function hasHeader(headers:PortalRequest["headers"],wanted:string):boolean{return typeof headers==="object"&&headers!==null&&Object.keys(headers).some(k=>k.toLowerCase()===wanted)}
function exactObject(value:unknown,names:readonly string[]):Record<string,unknown>|null {
 if(typeof value!=="object"||value===null||Array.isArray(value))return null;
 const p=Object.getPrototypeOf(value);if(p!==Object.prototype&&p!==null)return null;
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(k=>typeof k!=="string"||!names.includes(k)))return null;
 const out=Object.create(null) as Record<string,unknown>;
 for(const name of names){const d=Object.getOwnPropertyDescriptor(value,name);if(!d||!("value" in d)||!d.enumerable)return null;out[name]=d.value;} return out;
}
function res(status:number,body?:unknown,extra:Record<string,string>={}):PortalResponse{return{status,...(body===undefined?{}:{body}),headers:{...STUDENT_PORTAL_SECURITY_HEADERS,...extra}}}
function safeQuery(query:PortalRequest["query"]):{limit:number;cursor:string|null}|null {
 if(query===undefined)return{limit:25,cursor:null}; const p=Object.getPrototypeOf(query);if(p!==Object.prototype&&p!==null)return null;
 const keys=Reflect.ownKeys(query);if(keys.some(k=>typeof k!=="string"||k!=="limit"&&k!=="cursor"))return null;
 const limitDescriptor=Object.getOwnPropertyDescriptor(query,"limit");const cursorDescriptor=Object.getOwnPropertyDescriptor(query,"cursor");
 if(limitDescriptor&&!("value" in limitDescriptor)||cursorDescriptor&&!("value" in cursorDescriptor))return null;
 const rawLimit=limitDescriptor?.value;const cursor=cursorDescriptor?.value??null;
 if(rawLimit!==undefined&&(typeof rawLimit!=="string"||!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)))return null;
 const limit=rawLimit===undefined?25:Number(rawLimit);
 if(typeof cursor!=="string"&&cursor!==null||cursor!==null&&!/^[A-Za-z0-9_.-]{1,512}$/.test(cursor))return null;
 return{limit,cursor};
}
function exactStringArray(value:unknown):string[]|null {if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>10)return null;const out:string[]=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!("value" in d)||typeof d.value!=="string"||!/^[A-Za-z0-9_-]{1,80}$/.test(d.value))return null;out.push(d.value)}if(Reflect.ownKeys(value).some(k=>k!=="length"&&(typeof k!=="string"||!/^\d+$/.test(k)||Number(k)>=value.length))||new Set(out).size!==out.length)return null;return out}
function boundedMeals(value:unknown):MealDefinition[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>100)throw new Error("invalid capability result");
 const meals:MealDefinition[]=[];
 for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!("value" in d))throw new Error("invalid capability result");const x=exactObject(d.value,["id","name","baseCredits","modifiers"]);if(!x||typeof x.id!=="string"||x.id.length<1||x.id.length>80||typeof x.name!=="string"||x.name.length<1||x.name.length>120||!Number.isSafeInteger(x.baseCredits)||Number(x.baseCredits)<1||Number(x.baseCredits)>20||!Array.isArray(x.modifiers)||Object.getPrototypeOf(x.modifiers)!==Array.prototype||x.modifiers.length>50)throw new Error("invalid capability result");const modifiers:MealModifier[]=[];for(let j=0;j<x.modifiers.length;j++){const md=Object.getOwnPropertyDescriptor(x.modifiers,String(j));const m=md&&"value" in md?exactObject(md.value,["id","name","creditDelta"]):null;if(!m||typeof m.id!=="string"||m.id.length<1||m.id.length>80||typeof m.name!=="string"||m.name.length<1||m.name.length>120||!Number.isSafeInteger(m.creditDelta)||Number(m.creditDelta)<-19||Number(m.creditDelta)>20)throw new Error("invalid capability result");modifiers.push({id:m.id,name:m.name,creditDelta:Number(m.creditDelta)})}meals.push({id:x.id,name:x.name,baseCredits:Number(x.baseCredits),modifiers})}
 return meals;
}
function validAuthPrincipal(value:unknown):{studentId:string}|null {
 if(typeof value!=="object"||value===null)return null;
 const outcome=Object.getOwnPropertyDescriptor(value,"outcome");
 if(!outcome||!("value" in outcome)||outcome.value!=="valid")return null;
 const student=Object.getOwnPropertyDescriptor(value,"studentId");
 return student&&"value" in student&&typeof student.value==="string"&&UUID.test(student.value)?{studentId:student.value}:null;
}
export function createStudentPortalHandler(config:{endpoint:PortalEndpoint;allowedOrigin:string;authStore:Pick<AuthStore,"validateSession"|"revokeSession">;cryptography:AuthCryptography;store:StudentPortalStore}) {
 return async(request:PortalRequest):Promise<PortalResponse>=>{
  const requestOrigin=ownHeader(request.headers,"origin");
  const respond=(status:number,body?:unknown,extra:Record<string,string>={})=>res(status,body,{...(requestOrigin===config.allowedOrigin?{"Access-Control-Allow-Origin":config.allowedOrigin,"Vary":"Origin"}:{}),...extra});
  const mutation=config.endpoint==="reservation-cancel"||config.endpoint==="logout"||config.endpoint==="reservations"&&request.method==="POST";
  const allowedMethods=config.endpoint==="reservations"?["GET","POST"]:config.endpoint==="reservation-cancel"||config.endpoint==="logout"?["POST"]:["GET"];
  if(!allowedMethods.includes(request.method??""))return respond(405,{error:"method_not_allowed"},{Allow:allowedMethods.join(", ")});
  if(mutation){const origin=ownHeader(request.headers,"origin");const site=ownHeader(request.headers,"sec-fetch-site");if(origin!==config.allowedOrigin||hasHeader(request.headers,"sec-fetch-site")&&site!=="same-origin")return respond(403,{error:"forbidden"});if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(ownHeader(request.headers,"content-type")??""))return respond(415,{error:"unsupported_media_type"});}
  else {const origin=ownHeader(request.headers,"origin");if(hasHeader(request.headers,"origin")&&origin!==config.allowedOrigin)return respond(403,{error:"forbidden"});if(request.body!==undefined||hasHeader(request.headers,"content-type")||hasHeader(request.headers,"transfer-encoding")||hasHeader(request.headers,"content-length"))return respond(400,{error:"invalid_request"});}
  const parsed=parseSessionCookie(ownHeader(request.headers,"cookie")); if(!parsed)return respond(401,{error:"unauthorized"});
  let digest:Buffer;let validated:unknown;try{digest=config.cryptography.digestSession(parsed.bearer);validated=await config.authStore.validateSession({sessionId:parsed.sessionId,digest});}catch{return respond(401,{error:"unauthorized"});}
  const principal=validAuthPrincipal(validated);if(!principal)return respond(401,{error:"unauthorized"}); const portalPrincipal={studentId:principal.studentId,sessionId:parsed.sessionId,digest};
  try{
   if(config.endpoint==="me")return respond(200,await config.store.me(portalPrincipal));
   if(config.endpoint==="meals")return respond(200,{items:boundedMeals(await config.store.meals(portalPrincipal))});
   if(config.endpoint==="purchases"){const q=safeQuery(request.query);return q?respond(200,await config.store.purchases(portalPrincipal,q)):respond(400,{error:"invalid_request"});}
   if(config.endpoint==="reservations"&&request.method==="GET"){const q=safeQuery(request.query);return q?respond(200,await config.store.reservations(portalPrincipal,q)):respond(400,{error:"invalid_request"});}
   if(config.endpoint==="reservations") {const body=exactObject(request.body,["mealId","modifierIds","idempotencyKey"]);const modifierIds=body?exactStringArray(body.modifierIds):null;if(!body||typeof body.mealId!=="string"||!/^[A-Za-z0-9_-]{1,80}$/.test(body.mealId)||!modifierIds||typeof body.idempotencyKey!=="string"||!IDEMPOTENCY.test(body.idempotencyKey))return respond(400,{error:"invalid_request"});return respond(201,await config.store.reserve({principal:portalPrincipal,mealId:body.mealId,modifierIds,idempotencyKey:body.idempotencyKey}));}
   if(config.endpoint==="reservation-cancel"){const body=exactObject(request.body,["idempotencyKey"]);if(!UUID.test(request.reservationId??"")||!body||typeof body.idempotencyKey!=="string"||!IDEMPOTENCY.test(body.idempotencyKey))return respond(400,{error:"invalid_request"});return respond(200,await config.store.reverse({principal:portalPrincipal,reservationId:request.reservationId!,idempotencyKey:body.idempotencyKey}));}
   const body=exactObject(request.body,[]);if(!body)return respond(400,{error:"invalid_request"});let revoked=true;try{await config.authStore.revokeSession({sessionId:parsed.sessionId,digest});}catch{revoked=false}const cookie={"Set-Cookie":`${COOKIE_NAME}=; Max-Age=0; Path=/api/downtown-u; HttpOnly; Secure; SameSite=Strict`};return revoked?respond(204,undefined,cookie):respond(503,{error:"unavailable"},cookie);
  }catch(error){if(error instanceof PortalInvalidRequestError)return respond(400,{error:"invalid_request"});if(error instanceof PortalRateLimitError)return respond(429,{error:"rate_limited"},{"Retry-After":"600"});if(error instanceof PortalInsufficientCreditsError)return respond(409,{error:"insufficient_credits"});if(error instanceof PortalConflictError)return respond(409,{error:"conflict"});if(error instanceof PortalNotFoundError)return respond(404,{error:"not_found"});return respond(503,{error:"unavailable"});}
 };
}
