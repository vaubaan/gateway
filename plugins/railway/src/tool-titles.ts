/**
 * What each tool of the `railway` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const railwayToolTitles: Readonly<Record<string, string>> = {
  [TOOL.whoami]: 'Read who the account is',
  [TOOL.listProjects]: 'List projects',
  [TOOL.createProject]: 'Create a project',
  [TOOL.listServices]: 'List services and environments',
  [TOOL.listDeployments]: 'List deployments',
  [TOOL.getStatus]: 'Read the deployment status',
  [TOOL.getLogs]: 'Read logs',
  [TOOL.redeploy]: 'Redeploy a service',
  [TOOL.acceptDeploy]: 'Commit staged changes and deploy',
  [TOOL.railwayAgent]: "Ask Railway's agent to act",
  [TOOL.listVariables]: 'List environment variables',
  [TOOL.upsertVariable]: 'Set an environment variable',
  [TOOL.upsertVariables]: 'Set several environment variables',
  [TOOL.deleteVariable]: 'Delete an environment variable',
};
