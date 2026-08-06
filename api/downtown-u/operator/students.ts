import {
  createProductionOperatorReadHandler,
  operatorReadRawConfig,
  type NodeOperatorReadRequest,
  type NodeOperatorReadResponse,
} from "./read-handler";

export const config = operatorReadRawConfig;
const handler = createProductionOperatorReadHandler("students");
export default (request: NodeOperatorReadRequest, response: NodeOperatorReadResponse) => handler(request, response);
