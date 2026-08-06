import { createProductionOperatorAuthHandler, operatorRawJsonConfig, type NodeOperatorAuthRequest, type NodeOperatorAuthResponse } from "../auth-handler";
export const config = operatorRawJsonConfig;
const handler = createProductionOperatorAuthHandler("verify-email");
export default (request: NodeOperatorAuthRequest, response: NodeOperatorAuthResponse) => handler(request, response);
