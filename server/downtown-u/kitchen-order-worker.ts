import type { KitchenClaim, KitchenObservedOrder, PostgresKitchenJobStore } from "./postgres-kitchen-job-store";
import { SquareApiError, type SquareCheckoutClient, type SquareResource } from "./square-client";

const LOCATION="LPPWSSV03BHK8";
type Obj=Record<string,unknown>;
function obj(v:unknown):v is Obj{return typeof v==="object"&&v!==null&&!Array.isArray(v)}
function own(o:Obj,k:string):unknown{const d=Object.getOwnPropertyDescriptor(o,k);return d&&"value" in d?d.value:undefined}
function text(o:Obj,k:string):string|null{const v=own(o,k);return typeof v==="string"?v:null}
function version(o:Obj):number|null{const v=own(o,"version");return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null}
function observedOrder(v:unknown):KitchenObservedOrder|null{if(!obj(v))return null;const id=text(v,"id"),parsedVersion=version(v);return id&&/^[A-Za-z0-9_-]{1,192}$/.test(id)&&parsedVersion!==null?{id,version:parsedVersion}:null}
export class KitchenOrderMismatchError extends Error{constructor(){super("Square kitchen order mismatch");this.name="KitchenOrderMismatchError"}}
function modifierIds(modifiers:unknown[]):string[]{const ids=modifiers.map(v=>obj(v)&&typeof own(v,"squareCatalogObjectId")==="string"?String(own(v,"squareCatalogObjectId")):"");if(ids.some(x=>!x)||new Set(ids).size!==ids.length)throw new Error("invalid trusted snapshot");return ids.sort()}
const ZERO_USD={amount:0,currency:"USD"} as const;
function zeroMoney(value:unknown,required=false):boolean{if(value===undefined)return !required;if(!obj(value))return false;const amount=own(value,"amount"),currency=own(value,"currency");return amount===0&&currency==="USD"}
function emptyArray(o:Obj,key:string):boolean{const value=own(o,key);return value===undefined||Array.isArray(value)&&value.length===0}
function exactZeroEconomics(order:Obj,line:Obj,modifiers:Obj[]):boolean{
 if(!zeroMoney(own(order,"total_money"),true))return false;
 for(const key of ["total_tax_money","total_discount_money","total_tip_money","total_service_charge_money","return_amounts"])
  if(!zeroMoney(own(order,key)))return false;
 for(const key of ["taxes","discounts","service_charges","returns","rewards"])if(!emptyArray(order,key))return false;
 for(const key of ["base_price_money","gross_sales_money","total_tax_money","total_discount_money","total_money","variation_total_price_money"])
  if(!zeroMoney(own(line,key),key==="base_price_money"||key==="total_money"))return false;
 for(const key of ["applied_taxes","applied_discounts"])if(!emptyArray(line,key))return false;
 return modifiers.every(m=>zeroMoney(own(m,"base_price_money"))&&zeroMoney(own(m,"total_price_money")));
}
function verifyBase(order:SquareResource,claim:KitchenClaim,state:"OPEN"|"CANCELED"):{id:string;version:number}{
 const id=text(order,"id"),v=version(order);if(!id||v===null||text(order,"location_id")!==LOCATION||text(order,"reference_id")!==claim.referenceId||text(order,"state")!==state)throw new KitchenOrderMismatchError();return{id,version:v};
}
function verifyTrustedOrderContent(order:SquareResource,claim:KitchenClaim,allowedFulfillmentStates:readonly string[]):void{
 const lines=own(order,"line_items");if(!Array.isArray(lines)||lines.length!==1||!obj(lines[0]))throw new KitchenOrderMismatchError();
 const line=lines[0];if(text(line,"quantity")!=="1"||text(line,"catalog_object_id")!==claim.mealCatalogObjectId)throw new KitchenOrderMismatchError();
 const got=own(line,"modifiers"),expected=modifierIds(claim.modifiers);if(!Array.isArray(got)||got.length!==expected.length||got.some(x=>!obj(x)))throw new KitchenOrderMismatchError();
 const modifierObjects=got as Obj[],actual=modifierObjects.map(x=>text(x,"catalog_object_id"));if(actual.some(x=>x===null)||new Set(actual).size!==actual.length||actual.slice().sort().join("\0")!==expected.join("\0")||!exactZeroEconomics(order,line,modifierObjects))throw new KitchenOrderMismatchError();
 const fulfillments=own(order,"fulfillments");if(!Array.isArray(fulfillments)||fulfillments.length!==1||!obj(fulfillments[0])||text(fulfillments[0],"type")!=="PICKUP"||!allowedFulfillmentStates.includes(text(fulfillments[0],"state")??""))throw new KitchenOrderMismatchError();
 const pickup=own(fulfillments[0],"pickup_details");if(!obj(pickup)||text(pickup,"schedule_type")!=="ASAP")throw new KitchenOrderMismatchError();
 const recipient=own(pickup,"recipient");if(!obj(recipient)||text(recipient,"display_name")!=="Downtown U"||Object.keys(recipient).some(key=>key!=="display_name"))throw new KitchenOrderMismatchError();
}
export function verifyCreatedKitchenOrder(order:SquareResource,claim:KitchenClaim):{id:string;version:number}{const result=verifyBase(order,claim,"OPEN");verifyTrustedOrderContent(order,claim,["PROPOSED"]);return result}
export function verifyCancelledKitchenOrder(order:SquareResource,claim:KitchenClaim):{id:string;version:number}{const result=verifyBase(order,claim,"CANCELED");if(result.id!==claim.squareOrderId||claim.squareOrderVersion===null||result.version<claim.squareOrderVersion)throw new KitchenOrderMismatchError();verifyTrustedOrderContent(order,claim,["PROPOSED","CANCELED"]);return result}
export function createKitchenOrderBody(claim:KitchenClaim):SquareResource{return{
 idempotency_key:claim.idempotencyKey,
 order:{location_id:LOCATION,reference_id:claim.referenceId,
  line_items:[{quantity:"1",catalog_object_id:claim.mealCatalogObjectId,base_price_money:ZERO_USD,modifiers:modifierIds(claim.modifiers).map(catalog_object_id=>({catalog_object_id,base_price_money:ZERO_USD}))}],
  fulfillments:[{type:"PICKUP",state:"PROPOSED",pickup_details:{schedule_type:"ASAP",recipient:{display_name:"Downtown U"}}}]}
}}
export function cancelKitchenOrderBody(claim:KitchenClaim):SquareResource{if(!claim.squareOrderId||claim.squareOrderVersion===null)throw new Error("invalid cancellation claim");return{idempotency_key:claim.idempotencyKey,order:{location_id:LOCATION,version:claim.squareOrderVersion,state:"CANCELED"}}}
function failure(error:unknown):{code:string;permanent:boolean;delay:number}{
 if(error instanceof KitchenOrderMismatchError)return{code:"provider_mismatch",permanent:true,delay:60};
 if(error instanceof SquareApiError){if(error.kind==="configuration")return{code:"configuration",permanent:true,delay:60};if(error.kind==="permanent"&&error.status!==undefined)return{code:"provider_rejected",permanent:true,delay:60};return{code:error.status===429?"rate_limited":"provider_ambiguous",permanent:false,delay:error.status===429?120:30};}
 return{code:"provider_ambiguous",permanent:false,delay:30};
}
export type KitchenClaimOutcome="completed"|"deferred";
export interface KitchenBatchResult{claimed:number;completed:number;deferred:number}
export async function processKitchenClaim(store:PostgresKitchenJobStore,square:SquareCheckoutClient,claim:KitchenClaim):Promise<KitchenClaimOutcome>{
 let observed:KitchenObservedOrder|null=null;
 try{
  if(claim.locationId!==LOCATION||square.locationId!==LOCATION)throw new SquareApiError("configuration","Kitchen location mismatch");
  const order=claim.action==="create"?await square.createOrder(createKitchenOrderBody(claim)):await square.updateOrder(claim.squareOrderId!,cancelKitchenOrderBody(claim));
  if(claim.action==="create")observed=observedOrder(order);
  const verified=claim.action==="create"?verifyCreatedKitchenOrder(order,claim):verifyCancelledKitchenOrder(order,claim);
  const finalized=await store.finalize(claim,verified.id,verified.version);if(claim.action==="create"?!["created","cancel_pending"].includes(finalized):finalized!=="cancelled")throw new Error("stale kitchen finalization");
  return finalized==="cancel_pending"?"deferred":"completed";
 }catch(error){const f=failure(error);let recorded:string;try{recorded=await store.fail(claim,f.code,f.permanent,f.delay,observed)}catch{throw new Error("Kitchen order failure could not be persisted")}if(!["pending","cancel_pending","cancelled","operator_review"].includes(recorded))throw new Error("Kitchen order failure could not be persisted");return "deferred"}
}
export async function runKitchenOrderBatch(store:PostgresKitchenJobStore,square:SquareCheckoutClient,limit=10,maxMilliseconds=20_000):Promise<KitchenBatchResult>{
 if(!Number.isInteger(limit)||limit<1||limit>20||!Number.isInteger(maxMilliseconds)||maxMilliseconds<1000||maxMilliseconds>25_000)throw new Error("invalid kitchen batch");
 const started=Date.now(),result:KitchenBatchResult={claimed:0,completed:0,deferred:0};
 while(result.claimed<limit&&Date.now()-started<maxMilliseconds){
  const claims=await store.claim(1);if(claims.length===0)break;if(claims.length!==1)throw new Error("invalid kitchen claim batch");
  const outcome=await processKitchenClaim(store,square,claims[0]);result.claimed++;result[outcome]++;
 }
 return result;
}
