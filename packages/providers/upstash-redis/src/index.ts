export { UpstashRedisAdapter } from './upstash-redis-adapter.ts';
export { availableTools as upstashRedisAvailableTools } from './tools.ts';

// v4 risk-based exports
export { dataModel as upstashRedisDataModel } from './data-model.ts';
export { upstashRedisRiskCatalog } from './risk-catalog.ts';
export { classifyUpstashRedisV4 } from './risk-classifier.ts';
export type { ClassifyResult as UpstashRedisClassifyV4Result } from './risk-classifier.ts';
