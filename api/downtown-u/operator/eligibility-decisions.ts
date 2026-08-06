import { createProductionOperatorEligibilityHandler, operatorEligibilityRawConfig } from "./eligibility-handler";

export const config = operatorEligibilityRawConfig;
export default createProductionOperatorEligibilityHandler();
