import { Menu } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { Sheet,SheetClose,SheetContent,SheetDescription,SheetHeader,SheetTitle,SheetTrigger } from "@/components/ui/sheet";
import { useOperatorSession } from "./session";
import type { OperatorRole } from "./types";

const roleLabels:Record<OperatorRole,string>={eligibility_reviewer:"Eligibility review",reconciliation_operator:"Reconciliation",credit_adjuster:"Credit support",audit_exporter:"Audit export"};
const nav=[
  {to:"/downtown-u/operator/students",label:"Students",roles:["eligibility_reviewer","reconciliation_operator"] as OperatorRole[]},
  {to:"/downtown-u/operator/purchases",label:"Purchases",roles:["reconciliation_operator"] as OperatorRole[]},
  {to:"/downtown-u/operator/redemptions",label:"Meal activity",roles:["reconciliation_operator"] as OperatorRole[]},
  {to:"/downtown-u/operator/reconciliation",label:"Reconciliation",roles:["reconciliation_operator"] as OperatorRole[]},
];
function Navigation({mobile=false}:{mobile?:boolean}){const {session}=useOperatorSession();return <nav aria-label="Operator sections" className="mt-8"><ul className="space-y-1">{nav.filter(item=>item.roles.some(role=>session.operator.roles.includes(role))).map(item=><li key={item.to}>{mobile?<SheetClose asChild><NavItem {...item}/></SheetClose>:<NavItem {...item}/>}</li>)}</ul></nav>;}
function NavItem({to,label}:{to:string;label:string}){return <NavLink to={to} className={({isActive})=>`flex min-h-11 items-center border-l-2 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7c184] ${isActive?"border-[#d7c184] bg-[#2b2924] text-[#fff7e5]":"border-transparent text-[#c8c0b1] hover:bg-[#24231f] hover:text-white"}`}>{label}</NavLink>;}
function Brand(){return <div><p className="font-display text-xl font-semibold tracking-wide text-[#fff7e5]">Downtown U</p><p className="mt-1 text-xs uppercase tracking-[0.18em] text-[#d7c184]">Proper Cuisine</p></div>;}
export default function OperatorShell(){const {session}=useOperatorSession();return <div data-testid="operator-shell" className="min-h-[100dvh] w-full overflow-x-hidden bg-[#eee7d8] font-body text-[#1b1a17]">
  <a href="#operator-main" className="fixed left-3 top-3 z-[60] -translate-y-20 rounded-md bg-[#fff7e5] px-4 py-3 font-semibold text-[#171715] focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-[#8b743d] motion-reduce:transition-none">Skip to content</a>
  <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-[#34312b] bg-[#171715] px-5 py-7 md:flex md:flex-col"><Brand/><Navigation/><div className="mt-auto border-t border-[#3c3932] pt-5"><p className="truncate text-sm font-semibold text-[#fff7e5]">{session.operator.displayName}</p><ul aria-label="Access areas" className="mt-2 space-y-1 text-xs text-[#aaa294]">{session.operator.roles.map(role=><li key={role}>{roleLabels[role]}</li>)}</ul></div></aside>
  <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between border-b border-[#34312b] bg-[#171715] px-4 text-[#fff7e5] md:hidden"><Brand/><Sheet><SheetTrigger asChild><button type="button" className="grid min-h-11 min-w-11 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7c184]" aria-label="Open navigation"><Menu aria-hidden="true" className="h-5 w-5"/></button></SheetTrigger><SheetContent side="left" className="w-[min(88vw,320px)] border-[#34312b] bg-[#171715] text-[#fff7e5] motion-reduce:duration-0 [&>button]:min-h-11 [&>button]:min-w-11"><SheetHeader className="text-left"><SheetTitle className="font-display text-[#fff7e5]">Downtown U</SheetTitle><SheetDescription className="text-[#aaa294]">Staff sections</SheetDescription></SheetHeader><Navigation mobile/><div className="mt-8 border-t border-[#3c3932] pt-5 text-sm">{session.operator.displayName}</div></SheetContent></Sheet></header>
  <main id="operator-main" className="min-w-0 md:ml-[248px]"><div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 md:px-8 md:py-8 lg:px-10"><Outlet/></div></main>
</div>;}
