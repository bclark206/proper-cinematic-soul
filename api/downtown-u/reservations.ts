import { createProductionStudentPortalHandler, portalRawJsonConfig, type NodePortalRequest, type NodePortalResponse } from "./student-portal-handler";
export const config=portalRawJsonConfig;const handler=createProductionStudentPortalHandler("reservations");
export default (request:NodePortalRequest,response:NodePortalResponse)=>handler(request,response);
