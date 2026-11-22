/**
 * `@vaubaan/plugin-github` — the GitHub plugin.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/github.md ; guide : plugins/README.md.
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
import { githubGitRemoteOf } from './git-remote.ts';
import { githubExamples } from './examples.ts';
import { EXCLUDED_TOOLS, SERVICE_ID } from './identity.ts';
import { GITHUB_ICON, GITHUB_ICON_COLOR } from './icon.ts';
import { githubToolTitles } from './tool-titles.ts';
import { githubTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const GITHUB_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const githubCatalog = loadCatalogFile(GITHUB_CATALOG_PATH);

/** The git remote ; its working-branch words are read from the catalog, the one list. */
export const githubGitRemote = githubGitRemoteOf(githubCatalog.catalog);

export const githubPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'GitHub',
  icon: GITHUB_ICON,
  iconColor: GITHUB_ICON_COLOR,
  resourceNoun: { one: 'repository', other: 'repositories' },
  version: '5.4.1',
  description:
    'Repositories, branches, files, pull requests, issues, releases and workflows a fine-grained token reaches.',
  summary:
    "One account is one repository and a fine-grained personal access token made at GitHub for it alone; the repository is the account's one resource. Another repository is another account. A mission picks repositories and the permissions it holds on them. GitHub has no environment label: protected branches (main, master, release-*) and working branches (feature/*, fix/*, …) are told apart by two different permissions.",
  manualRevocation:
    'Delete the token at GitHub, signed in as the account that created it: Settings, Developer settings, Personal access tokens, Fine-grained tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/github.md',
  // The instance as the agents' git remote (spec §4.1 ter) : clone, fetch and push
  // with the mission key as the password, every push decided ref by ref.
  gitRemote: githubGitRemote,
  tools: githubTools,
  toolTitles: githubToolTitles,
  excludedTools: EXCLUDED_TOOLS,
  examples: githubExamples,
  dataModel: githubDataModel,
  catalog: githubCatalog.catalog,
  credential: githubCredential,
  classify: classifyGithub,
  execute: executeGithub,
  discoverResources: discoverGithubResources,
});

export default githubPlugin;

export { classifyGithub, githubCredential, githubDataModel, githubTools };
export {
  expiryOf,
  GITHUB_REPOSITORY_FIELD,
  GITHUB_TOKEN_FIELD,
  verifyGithubToken,
} from './credential.ts';
export { GITHUB_TOKEN_PERMISSIONS } from './permissions.ts';
export { EXCLUDED_TOOLS, SERVICE_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { EXAMPLE_REPOSITORY, githubExamples } from './examples.ts';
export { discoverGithubResources, executeGithub } from './execute.ts';
export { GIT_FETCH_TOOL, GIT_PUSH_TOOL, readGitCall } from './git-call.ts';
export { COMPARE_MAX_COMMITS, COMPARE_MAX_FILES, workingBranchesOf } from './git-remote.ts';
