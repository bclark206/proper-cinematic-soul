import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { describe,expect,it,vi } from "vitest";
import { createOperatorAuthCryptography } from "../../../../server/downtown-u/operator/auth-crypto";
import {
  createOperatorReadHandler,
  createProductionOperatorReadHandler,
  type NodeOperatorReadResponse,
} from "../read-handler";
import * as studentsRoute from "../students";
import * as purchasesRoute from "../purchases";
import * as redemptionsRoute from "../redemptions";
import * as reconciliationRoute from "../reconciliation";
const origin="https://operator.example.test",session="123e4567-e89b-42d3-a456-426614174000",bearer="A".repeat(43),secret="AyQ7Gu1FZ6fR1esxrvIGvIN8Yl-Bhb12oZSjgqU2xLY";
const cookie=`__Host-downtown_u_operator_session=v1.${session}.${bearer}`;
function req(method="GET",url="/api/downtown-u/operator/students",headers:Record<string,string>={cookie}){return Object.assign(Readable.from([]),{method,url,headers});}
function res(){const result={status:0,body:undefined as unknown,headers:{} as Record<string,string>};const response:NodeOperatorReadResponse={setHeader:(k,v)=>{result.headers[k]=v;},status:n=>({json:body=>{result.status=n;result.body=body;}})};return {result,response};}
function item(id="223e4567-e89b-42d3-a456-426614174000"){return {id,eligibilityStatus:"approved",maskedEmail:"a***@e***.edu",maskedPhone:"+***********2345",createdAt:"2026-08-06T12:00:00.000Z",updatedAt:"2026-08-06T12:00:00.000Z"};}
function setup(outcome:unknown={outcome:"authorized",items:[item()]}){const read=vi.fn().mockResolvedValue(outcome);const compose=vi.fn(()=>({store:{read},cryptography:createOperatorAuthCryptography(secret)}));return {read,compose,handler:createOperatorReadHandler("students",origin,compose)};}
describe("operator dashboard GET API",()=>{
 it("fails malformed method descriptors closed without invoking accessors",async()=>{
  const s=setup(),o=res(),getter=vi.fn(()=>"GET");
  const request=req();
  Object.defineProperty(request,"method",{get:getter,configurable:true});
  await s.handler(request,o.response);
  expect(o.result).toMatchObject({status:400,body:{error:"invalid_request"}});
  expect(getter).not.toHaveBeenCalled();
  expect(s.compose).not.toHaveBeenCalled();
 });

 it("validates production DB configuration before asking the pool boundary",async()=>{
  const getPool=vi.fn(),createStore=vi.fn(),o=res();
  await createProductionOperatorReadHandler("students",()=>({
   DOWNTOWN_U_PUBLIC_APP_ORIGIN:origin,
   DOWNTOWN_U_OPERATOR_ENABLED:"1",
   DOWNTOWN_U_OPERATOR_AUTH_SECRET:secret,
   DOWNTOWN_U_OPERATOR_DATABASE_URL:"postgres://malformed",
  }),{getPool:getPool as never,createStore:createStore as never})(req(),o.response);
  expect(o.result).toMatchObject({status:503,body:{error:"unavailable"}});
  expect(getPool).not.toHaveBeenCalled();
  expect(createStore).not.toHaveBeenCalled();
 });
 it("maps method, boundary, origin, cookie, DB authority, and unavailable outcomes exactly",async()=>{
  const cases=[
   [req("POST"),405,{error:"method_not_allowed"}],
   [req("GET","/api/downtown-u/operator/students?limit=01"),400,{error:"invalid_request"}],
   [req("GET",undefined as never,{origin:"https://evil.test",cookie}),403,{error:"forbidden"}],
   [req("GET",undefined as never,{}),401,{error:"unauthorized"}],
  ] as const;
  for(const [request,status,body] of cases){const s=setup(),o=res();await s.handler(request,o.response);expect(o.result).toMatchObject({status,body,headers:{"Cache-Control":"private, no-store, max-age=0","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"}});expect(s.read).not.toHaveBeenCalled();}
  for(const [outcome,status] of [[{outcome:"invalid",items:null},401],[{outcome:"denied",items:null},403]] as const){const s=setup(outcome),o=res();await s.handler(req(),o.response);expect(o.result.status).toBe(status);expect(s.read).toHaveBeenCalledOnce();}
  const unavailable=setup();unavailable.read.mockRejectedValue(new Error("db"));const o=res();await unavailable.handler(req(),o.response);expect(o.result).toMatchObject({status:503,body:{error:"unavailable"}});
 });
 it("requests limit+1 and creates a cursor from the last returned item, not the extra",async()=>{
  const second=item("323e4567-e89b-42d3-a456-426614174000"),s=setup({outcome:"authorized",items:[item(),second]}),o=res();await s.handler(req("GET","/api/downtown-u/operator/students?limit=1"),o.response);
  expect(s.read).toHaveBeenCalledWith(expect.objectContaining({requestedLimit:2,cursor:null,filters:{eligibilityStatus:null,studentId:null}}));expect(o.result.status).toBe(200);const body=o.result.body as {items:unknown[];nextCursor:string};expect(body.items).toEqual([item()]);expect(body.nextCursor).toBeTypeOf("string");expect(body.nextCursor).not.toContain(session);expect(body.nextCursor).not.toContain(bearer);
  const next=setup({outcome:"authorized",items:[]}),o2=res();await next.handler(req("GET","/api/downtown-u/operator/students?limit=1&cursor="+body.nextCursor),o2.response);expect(next.read).toHaveBeenCalledWith(expect.objectContaining({cursor:{createdAt:item().createdAt,id:item().id}}));
 });
 it("maps an internal cursor digest failure to unavailable without calling the store",async()=>{
  const good=setup({outcome:"authorized",items:[item(),item("323e4567-e89b-42d3-a456-426614174000")]});
  const first=res();
  await good.handler(req("GET","/api/downtown-u/operator/students?limit=1"),first.response);
  const cursor=(first.result.body as {nextCursor:string}).nextCursor;
  const read=vi.fn();
  const failure=new TypeError("cursor digest provider failed");
  const cryptography=createOperatorAuthCryptography(secret);
  const handler=createOperatorReadHandler("students",origin,()=>({store:{read},cryptography:{
   digestSession:cryptography.digestSession,
   digestReadCursor(){throw failure;},
  }}));
  const output=res();
  await handler(req("GET","/api/downtown-u/operator/students?limit=1&cursor="+cursor),output.response);
  expect(output.result).toMatchObject({status:503,body:{error:"unavailable"}});
  expect(read).not.toHaveBeenCalled();
 });
 it("keeps malformed base64, JSON, and MAC cursors classified as invalid requests",async()=>{
  const good=setup({outcome:"authorized",items:[item(),item("323e4567-e89b-42d3-a456-426614174000")]});
  const first=res();
  await good.handler(req("GET","/api/downtown-u/operator/students?limit=1"),first.response);
  const valid=(first.result.body as {nextCursor:string}).nextCursor;
  const [payload,mac]=valid.split(".");
  const malformedJson=Buffer.from("{").toString("base64url")+"."+mac;
  const cursors=["YR."+"A".repeat(43),malformedJson,payload+"."+mac.slice(0,-1)+(mac.endsWith("A")?"B":"A")];
  for(const cursor of cursors){
   const current=setup(),output=res();
   await current.handler(req("GET","/api/downtown-u/operator/students?cursor="+cursor),output.response);
   expect(output.result).toMatchObject({status:400,body:{error:"invalid_request"}});
   expect(current.read).not.toHaveBeenCalled();
  }
 });
 it("fails closed on a result trap with forbidden raw fields and never serializes it",async()=>{const trap={...item(),normalizedEmail:"raw-secret@example.test"};const s=setup({outcome:"authorized",items:[trap]}),o=res();await s.handler(req(),o.response);expect(o.result).toMatchObject({status:503,body:{error:"unavailable"}});expect(JSON.stringify(o.result)).not.toContain("raw-secret");});
 it("ships four import-safe physical routes and rewrites before the SPA",()=>{for(const route of [studentsRoute,purchasesRoute,redemptionsRoute,reconciliationRoute]){expect(route.default).toBeTypeOf("function");expect(route.config).toEqual({api:{bodyParser:false}});}const v=JSON.parse(readFileSync("vercel.json","utf8")) as {rewrites:Array<{source:string;destination:string}>};const spa=v.rewrites.findIndex(x=>x.source==="/(.*)");for(const name of ["students","purchases","redemptions","reconciliation"]){const path=`/api/downtown-u/operator/${name}`,indexes=v.rewrites.map((x,i)=>({...x,i})).filter(x=>x.source===path&&x.destination===path);expect(indexes).toHaveLength(1);expect(indexes[0].i).toBeLessThan(spa);}});
});
