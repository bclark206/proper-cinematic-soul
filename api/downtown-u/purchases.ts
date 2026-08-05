import { createProductionStudentPortalHandler, portalRawJsonConfig, type NodePortalRequest, type NodePortalResponse } from "./student-portal-handler";
export const config=portalRawJsonConfig;const handler=createProductionStudentPortalHandler("purchases");
export default (request:NodePortalRequest,response:NodePortalResponse)=>handler(request,response);
