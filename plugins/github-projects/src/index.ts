/**
 * `@vaubaan/plugin-github-projects` — one GitHub Projects (v2) board of an
 * organization : its fields, views and items.
 *
 * ADR : docs/decisions/github-projects-is-its-own-plugin.md.
 * Handbook : docs/handbook/services/github-projects.md.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { EXCLUDED_LIST_PROJECTS } from './call.ts';
import { classifyGithubProjects } from './classify.ts';
import { githubProjectsCredential } from './credential.ts';
import { githubProjectsDataModel } from './data-model.ts';
import { discoverGithubProjectsResources, executeGithubProjects } from './execute.ts';
import { githubProjectsExamples } from './examples.ts';
import { GITHUB_PROJECTS_ICON, GITHUB_PROJECTS_ICON_COLOR } from './icon.ts';
import { EXCLUDED_TOOL, SERVICE_ID } from './identity.ts';
import { githubProjectsToolTitles, githubProjectsTools } from './tools.ts';

export const githubProjectsCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const githubProjectsPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'GitHub Projects',
  icon: GITHUB_PROJECTS_ICON,
  iconColor: GITHUB_PROJECTS_ICON_COLOR,
  resourceNoun: { one: 'project', other: 'projects' },
  version: '0.1.0',
  description: "An organization's GitHub Projects board: its fields, views and items.",
  summary:
    "One account is one project of a GitHub organization, opened with a fine-grained personal access token; it is the account's one resource. A mission reads the board, adds cards, changes their fields, removes them, or creates fields and views. No environment: projects carry none.",
  manualRevocation:
    'Delete the token on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/github-projects.md',
  tools: githubProjectsTools,
  toolTitles: githubProjectsToolTitles,
  excludedTools: { [EXCLUDED_TOOL.listProjects]: EXCLUDED_LIST_PROJECTS },
  examples: githubProjectsExamples,
  dataModel: githubProjectsDataModel,
  catalog: githubProjectsCatalog.catalog,
  credential: githubProjectsCredential,
  classify: classifyGithubProjects,
  execute: executeGithubProjects,
  discoverResources: discoverGithubProjectsResources,
});

export default githubProjectsPlugin;

export { classifyGithubProjects, githubProjectsDataModel, githubProjectsTools };
export * from './call.ts';
export * from './credential.ts';
export { GITHUB_API_BASE } from './api.ts';
export { cursorOf, discoverGithubProjectsResources, executeGithubProjects } from './execute.ts';
export { EXCLUDED_TOOL, SERVICE_ID, TOOL } from './identity.ts';
export { EXAMPLE_OTHER_PROJECT, EXAMPLE_PROJECT, githubProjectsExamples } from './examples.ts';
