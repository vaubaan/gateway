export { SupabaseAdapter } from './supabase-adapter.ts';
export { availableTools as supabaseAvailableTools } from './tools.ts';
export { supabaseToolCapabilities, supabaseToolEnvResolution } from './classify.ts';

// v4 risk-based exports
export { supabaseDataModel } from './data-model.ts';
export {
  classifySupabaseV4,
  SUPPORTED_TOOLS as supabaseSupportedTools,
} from './risk-classifier.ts';
export type { ClassifyV4Result as SupabaseClassifyV4Result } from './risk-classifier.ts';
