import { Navigate, Route, Routes } from "react-router-dom";
import OperatorShell from "./shell";
import SessionBoundary, { useOperatorSession } from "./session";
import { PageHeading, Notice } from "./shared";
import { PurchasesPage, ReconciliationPage, RedemptionsPage, StudentsPage } from "./pages";
import type { OperatorRole } from "./types";
import StudentDetail from "./StudentDetail";

function Gate({roles,children}:{roles:OperatorRole[];children:React.ReactNode}){const {session}=useOperatorSession();return roles.some(role=>session.operator.roles.includes(role))?<>{children}</>:<AccessUnavailable/>;}
function AccessUnavailable(){return <><PageHeading description="This section is not available with your current staff access.">Access unavailable</PageHeading><Notice title="Limited access">Return to a section shown in the navigation.</Notice></>;}
function Home(){const {session}=useOperatorSession();if(session.operator.roles.includes("eligibility_reviewer"))return <Navigate replace to="students"/>;if(session.operator.roles.includes("reconciliation_operator"))return <Navigate replace to="reconciliation"/>;return <><PageHeading description="Your staff account has scoped access, but no dashboard list sections are available.">Operator home</PageHeading><Notice title="Scoped staff access">No read-only list views are available for your current access. Contact an administrator if your responsibilities have changed.</Notice></>;}
export default function OperatorDashboard(){return <SessionBoundary><Routes><Route element={<OperatorShell/>}><Route index element={<Home/>}/><Route path="students" element={<Gate roles={["eligibility_reviewer","reconciliation_operator"]}><StudentsPage/></Gate>}/><Route path="students/:studentId" element={<Gate roles={["eligibility_reviewer"]}><StudentDetail/></Gate>}/><Route path="purchases" element={<Gate roles={["reconciliation_operator"]}><PurchasesPage/></Gate>}/><Route path="redemptions" element={<Gate roles={["reconciliation_operator"]}><RedemptionsPage/></Gate>}/><Route path="reconciliation" element={<Gate roles={["reconciliation_operator"]}><ReconciliationPage/></Gate>}/><Route path="*" element={<AccessUnavailable/>}/></Route></Routes></SessionBoundary>;}
