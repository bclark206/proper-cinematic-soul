import {
  createProductionOperatorReadHandler,
  operatorReadRawConfig,
  type NodeOperatorReadRequest,
  type NodeOperatorReadResponse,
} from "./read-handler";

export const config = operatorReadRawConfig;
const handler = createProductionOperatorReadHandler("reconciliation");
export default (request: NodeOperatorReadRequest, response: NodeOperatorReadResponse) => handler(request, response);
