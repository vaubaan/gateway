/** The trust levels `vaubaan-plugin try` decides a call at, as a mission's gates would. */
export const TRUST_LEVELS = ['careful', 'trusting', 'autonomous'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
