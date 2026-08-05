import { createProductionStudentPortalHandler, portalRawJsonConfig, type NodePortalRequest, type NodePortalResponse } from "./student-portal-handler";
export const config=portalRawJsonConfig;const handler=createProductionStudentPortalHandler("me");
export default (request:NodePortalRequest,response:NodePortalResponse)=>handler(request,response);
