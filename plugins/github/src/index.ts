/**
 * `@vaubaan/plugin-github` — the GitHub provider plugin.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/github.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates
 * the definition at import time ; the YAML catalog is loaded here, once,
 * when the module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyGithub } from './classify.ts';
import { githubCredential } from './credential.ts';
import { githubDataModel } from './data-model.ts';
import { discoverGithubResources, executeGithub } from './execute.ts';
import { githubTokenCredential } from './token.ts';
import { githubGitRemote } from './git-remote.ts';
import { githubToolTitles } from './tool-titles.ts';
import { githubTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const GITHUB_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const githubCatalog = loadCatalogFile(GITHUB_CATALOG_PATH);

export const githubPlugin = definePlugin({
  id: 'github',
  displayName: 'GitHub',
  version: '3.1.0',
  description:
    'Repositories, branches, files, pull requests, issues, releases and workflows of the GitHub App installation.',
  summary:
    "One account is one installation of your company's GitHub App on an organisation, or a fine-grained personal access token; one resource is one repository. A mission picks repositories and the permissions it holds on them. GitHub has no environment label: protected branches (main, master, release-*) and working branches (feature/*, fix/*, …) are told apart by two different permissions.",
  manualRevocation:
    "Uninstall your company's GitHub App from the organisation, in the organisation's settings under GitHub Apps, once no other account of this gateway uses that installation. The gateway never uninstalls it: one installation may serve several accounts.",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/github.md',
  // The one tool that hands the agent a provider token (spec §2.4) : a short-lived
  // installation token scoped to the mission's repositories, for git itself. The
  // clone token carries `contents:read` only ; the push token writes, so a preset
  // may leave the first on `auto` and must gate the second by approval.
  tokenHandouts: [
    {
      tool: 'github__mint_install_token',
      riskIds: ['github.mint-install-token-clone', 'github.mint-install-token-push'],
      readOnlyRiskIds: ['github.mint-install-token-clone'],
    },
  ],
  // The instance as the agents' git remote (spec §4.1 ter) : clone, fetch and push
  // with the mission key as the password, every push decided ref by ref.
  gitRemote: githubGitRemote,
  tools: githubTools,
  toolTitles: githubToolTitles,
  dataModel: githubDataModel,
  catalog: githubCatalog.catalog,
  credential: githubCredential,
  // Beside the App : a fine-grained token pasted by hand, for a company that
  // registered no App (ADR token-connections-beside-the-integration-app).
  alternativeCredentials: [githubTokenCredential],
  classify: classifyGithub,
  execute: executeGithub,
  discoverResources: discoverGithubResources,
});

export default githubPlugin;

export { classifyGithub, githubCredential, githubDataModel, githubTools };
export {
  expiryOf,
  githubTokenCredential,
  GITHUB_TOKEN_FIELD,
  MINT_NEEDS_THE_APP,
  verifyGithubToken,
} from './token.ts';
export { buildAppJwt, mintInstallationToken } from './app-install.ts';
export { discoverGithubResources, executeGithub, MINT_PERMISSIONS } from './execute.ts';
export { GITHUB_APP_PERMISSIONS, githubManifestRegistration } from './app-manifest.ts';
export { assertAppPermissions, needsOf } from './permission-check.ts';
export { GIT_FETCH_TOOL, GIT_PUSH_TOOL, readGitCall } from './git-call.ts';
export {
  COMPARE_MAX_COMMITS,
  COMPARE_MAX_FILES,
  GIT_TOKEN_PERMISSIONS,
  githubGitRemote,
} from './git-remote.ts';
