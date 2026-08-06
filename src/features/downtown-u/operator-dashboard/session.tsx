import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readOperatorSession, OperatorRequestError } from "./api";
import type { OperatorSession } from "./types";
import { Notice } from "./shared";

interface Boundary { session: OperatorSession; endSession:()=>void }
const SessionContext=createContext<Boundary|null>(null);
// Shared only inside this feature; colocating keeps the boundary contract small.
// eslint-disable-next-line react-refresh/only-export-components
export function useOperatorSession(){const value=useContext(SessionContext);if(!value)throw new Error("session boundary missing");return value;}
export default function SessionBoundary({children}:{children:ReactNode}) {
  const client=useQueryClient(); const [ended,setEnded]=useState(false);
  const query=useQuery({queryKey:["operator","session"],queryFn:readOperatorSession,retry:false,staleTime:30_000,enabled:!ended});
  const endSession=useCallback(()=>{setEnded(true);client.clear();queueMicrotask(()=>client.clear());},[client]);
  const sessionError=query.error instanceof OperatorRequestError&&query.error.kind==="session";
  useEffect(()=>{if(sessionError)client.removeQueries({queryKey:["operator"],predicate:query=>query.queryKey[1]!=="session"});},[client,sessionError]);
  useEffect(()=>{if(ended)client.clear();},[client,ended]);
  if(ended||sessionError)return <BoundaryFrame><Notice role="alert" title="Session ended">Your staff session has ended. <a className="font-semibold underline underline-offset-4" href="/downtown-u/operator/auth">Sign in again</a> to continue.</Notice></BoundaryFrame>;
  if(query.isPending)return <BoundaryFrame><div role="status" aria-live="polite" className="p-6 text-sm">Checking staff access…</div></BoundaryFrame>;
  if(query.isError||!query.data)return <BoundaryFrame><Notice role="alert" title="Dashboard unavailable" retry={()=>void query.refetch()}>We couldn’t open the staff dashboard. Try again.</Notice></BoundaryFrame>;
  return <SessionContext.Provider value={{session:query.data,endSession}}>{children}</SessionContext.Provider>;
}
function BoundaryFrame({children}:{children:ReactNode}){return <main className="min-h-[100dvh] overflow-x-hidden bg-[#eee7d8] p-4 text-[#1b1a17] sm:p-8"><div className="mx-auto max-w-xl pt-20">{children}</div></main>;}
