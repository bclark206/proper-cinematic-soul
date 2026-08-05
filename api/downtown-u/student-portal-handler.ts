import { isUint8Array } from "node:util/types";
import type { Pool } from "pg";
import { createAuthPoolCache } from "./auth-handler";
import { authCryptographyFromEnvironment } from "../../server/downtown-u/auth";

import { PostgresAuthStore, type AuthStore } from "../../server/downtown-u/postgres-auth-store";
import { PostgresStudentPortalStore } from "../../server/downtown-u/postgres-student-portal-store";
import { createStudentPortalHandler, STUDENT_PORTAL_MAX_BODY_BYTES, STUDENT_PORTAL_SECURITY_HEADERS, type PortalEndpoint, type PortalRequest, type PortalResponse, type StudentPortalStore } from "../../server/downtown-u/student-portal";

export const portalRawJsonConfig={api:{bodyParser:false}};
export type NodePortalRequest=AsyncIterable<unknown>&{method?:string;headers:PortalRequest["headers"];rawHeaders?:string[];query?:Record<string,string|string[]|undefined>;body?:unknown;readableEnded?:boolean;destroy?(error?:Error):void};
export type NodePortalResponse={setHeader(name:string,value:string):void;status(code:number):{json(body:unknown):void;end?():void}};
function send(response:NodePortalResponse,result:PortalResponse){response.setHeader("Content-Type","application/json; charset=utf-8");for(const[name,value]of Object.entries(result.headers))response.setHeader(name,value);const target=response.status(result.status);if(result.body===undefined){if(target.end)target.end();else throw new Error("response does not support an empty body");}else target.json(result.body)}
function unsafeBody(request:NodePortalRequest){const body=Object.getOwnPropertyDescriptor(request,"body");const ended=Object.getOwnPropertyDescriptor(request,"readableEnded");return !!body&&(!("value" in body)||body.value!==undefined)||!!ended&&(!("value" in ended)||ended.value===true)}
function method(request:NodePortalRequest):string|undefined{const d=Object.getOwnPropertyDescriptor(request,"method");return d&&"value" in d&&typeof d.value==="string"?d.value:undefined}
function duplicateRawCookie(request:NodePortalRequest):boolean{const d=Object.getOwnPropertyDescriptor(request,"rawHeaders");if(!d||!("value" in d)||d.value===undefined)return false;if(!Array.isArray(d.value)||d.value.some((x:unknown)=>typeof x!=="string")||d.value.length%2!==0)return true;let count=0;for(let i=0;i<d.value.length;i+=2)if(d.value[i].toLowerCase()==="cookie")count++;return count>1}
async function rawBody(request:NodePortalRequest):Promise<Buffer|null>{const chunks:Buffer[]=[];let size=0;for await(const chunk of request){if(!isUint8Array(chunk))throw new Error("body");const bytes=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);size+=bytes.length;if(size>STUDENT_PORTAL_MAX_BODY_BYTES)return null;chunks.push(bytes)}return Buffer.concat(chunks,size)}
function destroyRequest(request:NodePortalRequest){const d=Object.getOwnPropertyDescriptor(request,"destroy");if(d&&"value" in d&&typeof d.value==="function")d.value.call(request)}
function requestHeaders(request:NodePortalRequest):PortalRequest["headers"]{const d=Object.getOwnPropertyDescriptor(request,"headers");return d&&"value" in d&&typeof d.value==="object"&&d.value!==null?d.value:Object.create(null) as PortalRequest["headers"]}
function allowedMethods(endpoint:PortalEndpoint):string[]{return endpoint==="reservations"?["GET","POST"]:endpoint==="reservation-cancel"||endpoint==="logout"?["POST"]:["GET"]}
function early(endpoint:PortalEndpoint,request:NodePortalRequest,status:number,error:string,allowedOrigin?:string):PortalResponse{const headers=requestHeaders(request);const origin=Object.keys(headers).filter(k=>k.toLowerCase()==="origin");let cors:Record<string,string>={};if(allowedOrigin&&origin.length===1){const d=Object.getOwnPropertyDescriptor(headers,origin[0]);if(d&&"value" in d&&d.value===allowedOrigin)cors={"Access-Control-Allow-Origin":allowedOrigin,"Vary":"Origin"}}return{status,body:{error},headers:{...STUDENT_PORTAL_SECURITY_HEADERS,...cors,...(status===405?{Allow:allowedMethods(endpoint).join(", ")}:{})}}}
function query(request:NodePortalRequest,endpoint:PortalEndpoint):{query:PortalRequest["query"];reservationId?:string}{const descriptor=Object.getOwnPropertyDescriptor(request,"query");if(!descriptor||!("value" in descriptor)||descriptor.value===undefined)return{query:undefined};const source=descriptor.value;if(typeof source!=="object"||source===null||Array.isArray(source)||(Object.getPrototypeOf(source)!==Object.prototype&&Object.getPrototypeOf(source)!==null)||Reflect.ownKeys(source).some(k=>typeof k!=="string"))return{query:{invalid:"1"}};const copy=Object.create(null) as Record<string,string|string[]|undefined>;let reservationId:string|undefined;let invalid=false;for(const key of Object.keys(source)){const d=Object.getOwnPropertyDescriptor(source,key);if(!d||!("value" in d)){invalid=true;continue}if(endpoint==="reservation-cancel"&&key==="id"&&typeof d.value==="string")reservationId=d.value;else copy[key]=d.value as string|string[]|undefined}if(invalid||endpoint==="reservation-cancel"&&Object.keys(copy).length!==0)return{query:{invalid:"1"}};return{query:copy,reservationId}}
export function createNodeStudentPortalHandler(endpoint:PortalEndpoint,core:ReturnType<typeof createStudentPortalHandler>,allowedOrigin?:string){return async(request:NodePortalRequest,response:NodePortalResponse)=>{const requestMethod=method(request);if(!allowedMethods(endpoint).includes(requestMethod??"")){send(response,early(endpoint,request,405,"method_not_allowed",allowedOrigin));return}if(duplicateRawCookie(request)){send(response,early(endpoint,request,401,"unauthorized",allowedOrigin));return}const mutation=endpoint==="logout"||endpoint==="reservation-cancel"||endpoint==="reservations"&&requestMethod==="POST";let body:unknown=undefined;if(unsafeBody(request)){send(response,early(endpoint,request,400,"invalid_request",allowedOrigin));return}let raw:Buffer|null;try{raw=await rawBody(request)}catch{raw=null}if(raw===null){destroyRequest(request);send(response,early(endpoint,request,400,"invalid_request",allowedOrigin));return}if(mutation){try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw))}catch{send(response,early(endpoint,request,400,"invalid_request",allowedOrigin));return}}else if(raw.length!==0){send(response,early(endpoint,request,400,"invalid_request",allowedOrigin));return}const parsed=query(request,endpoint);send(response,await core({method:requestMethod,headers:requestHeaders(request),body,query:parsed.query,reservationId:parsed.reservationId}))}}
const getPool=createAuthPoolCache();
export interface PortalBoundaries{getPool(url:string):Pool;auth(pool:Pool):AuthStore;store(pool:Pool):StudentPortalStore}
const boundaries:PortalBoundaries={getPool,auth:pool=>new PostgresAuthStore(pool),store:pool=>new PostgresStudentPortalStore(pool)};
function appOrigin(env:NodeJS.ProcessEnv){const value=env.DOWNTOWN_U_PUBLIC_APP_ORIGIN;if(!value)throw new Error("configuration");const url=new URL(value);if(url.protocol!=="https:"||url.origin!==value||url.pathname!=="/")throw new Error("configuration");return value}
export function createProductionStudentPortalHandler(
  endpoint:PortalEndpoint,
  env:NodeJS.ProcessEnv=process.env,
  b:PortalBoundaries=boundaries,
){
  let handler:ReturnType<typeof createNodeStudentPortalHandler>|undefined;
  return async(request:NodePortalRequest,response:NodePortalResponse)=>{
    if(env.DOWNTOWN_U_PORTAL_ENABLED!=="1"){
      let allowedOrigin:string|undefined;try{allowedOrigin=appOrigin(env)}catch{allowedOrigin=undefined}
      send(response,early(endpoint,request,503,"unavailable",allowedOrigin));return;
    }
    if(!handler){
      try{
        if(!env.DATABASE_URL)throw new Error("configuration");
        const allowedOrigin=appOrigin(env);
        const cryptography=authCryptographyFromEnvironment(env);
        const pool=b.getPool(env.DATABASE_URL);
        handler=createNodeStudentPortalHandler(endpoint,createStudentPortalHandler({
          endpoint,allowedOrigin,authStore:b.auth(pool),cryptography,store:b.store(pool),
        }),allowedOrigin);
      }catch{
        let allowedOrigin:string|undefined;try{allowedOrigin=appOrigin(env)}catch{allowedOrigin=undefined}
        handler=async(request,response)=>send(response,early(endpoint,request,503,"unavailable",allowedOrigin));
      }
    }
    await handler(request,response);
  };
}
