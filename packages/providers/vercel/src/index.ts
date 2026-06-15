export { VercelAdapter } from './vercel-adapter.ts';
export { availableTools as vercelAvailableTools } from './tools.ts';
export { vercelToolCapabilities, vercelToolEnvResolution } from './classify.ts';

// v4 risk-based exports
export { dataModel as vercelDataModel } from './data-model.ts';
export { classifyVercelV4 } from './risk-classifier.ts';
export type { ClassifyResult as VercelClassifyV4Result } from './risk-classifier.ts';
