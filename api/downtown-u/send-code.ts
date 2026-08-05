import { createProductionAuthHandler, rawJsonConfig, type NodeAuthRequest, type NodeAuthResponse } from "./auth-handler";

export const config = rawJsonConfig;
export { createNodeAuthHandler } from "./auth-handler";
const productionHandler = createProductionAuthHandler("send-code", process.env);

export default async function sendCode(request: NodeAuthRequest, response: NodeAuthResponse): Promise<void> {
  return productionHandler(request, response);
}
