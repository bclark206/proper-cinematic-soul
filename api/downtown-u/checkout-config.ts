import { createCheckoutApi, config } from "./checkout";
export { config };
export default createCheckoutApi(process.env, true);
