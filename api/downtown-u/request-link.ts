import { createProductionAuthHandler, rawJsonConfig, type NodeAuthRequest, type NodeAuthResponse } from "./auth-handler";

export const config = rawJsonConfig;
export { createNodeAuthHandler } from "./auth-handler";
const productionHandler = createProductionAuthHandler("request-link", process.env);

export default async function requestLink(request: NodeAuthRequest, response: NodeAuthResponse): Promise<void> {
  return productionHandler(request, response);
}
