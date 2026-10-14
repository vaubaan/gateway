/**
 * What each tool of the `railway` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const railwayToolTitles: Readonly<Record<string, string>> = {
  railway__whoami: 'Read who the account is',
  'railway__list-projects': 'List projects',
  'railway__create-project': 'Create a project',
  'railway__list-services': 'List services and environments',
  'railway__list-deployments': 'List deployments',
  'railway__get-status': 'Read the deployment status',
  'railway__get-logs': 'Read logs',
  railway__redeploy: 'Redeploy a service',
  'railway__accept-deploy': 'Commit staged changes and deploy',
  'railway__railway-agent': "Ask Railway's agent to act",
  'railway__list-variables': 'List environment variables',
  'railway__upsert-variable': 'Set an environment variable',
  'railway__upsert-variables': 'Set several environment variables',
  'railway__delete-variable': 'Delete an environment variable',
};
