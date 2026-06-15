export type { ProviderAdapter, ClassifyResult, ValidateResult, MintedToken } from './adapter.ts';
export { GitHubAdapter } from './github-adapter.ts';
export { availableTools as githubAvailableTools } from './tools.ts';
export { githubToolCapabilities, githubToolEnvResolution } from './classify.ts';
export { buildAppJwt, mintInstallationToken } from './app-install.ts';

// v4 risk-based plugin surface (Phase 0 / Phase 1) — coexists with the v1
// classifier above until Phase 3 of the migration (spec v4 §13).
export { githubDataModel } from './data-model.ts';
export { classifyGithubV4, type ClassifyV4Result } from './risk-classifier.ts';
