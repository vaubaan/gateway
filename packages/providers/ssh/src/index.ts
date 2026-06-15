export { availableTools as sshAvailableTools } from './tools.ts';
export { isReadAllowed } from './policy.ts';
export { sshExec } from './execute.ts';
export type { VpsSshBinding, ExecResult } from './execute.ts';
export {
  classifySsh,
  sshToolCapabilities,
  sshToolEnvResolution,
  type ClassifyResult,
} from './classify.ts';

// ─── v4 risk-based authorization ───────────────────────────────────────────
export { sshDataModel } from './data-model.ts';
export { sshRiskCatalog } from './risk-catalog.ts';
export {
  classifySshV4,
  looksLikeSecretFileRead,
  type ClassifyV4Result,
} from './risk-classifier.ts';
