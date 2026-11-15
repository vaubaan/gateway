/**
 * What each tool of the `vercel` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const vercelToolTitles: Readonly<Record<string, string>> = {
  [TOOL.searchVercelDocumentation]: 'Search the Vercel documentation',
  [TOOL.deployToVercel]: 'Deploy the project',
  [TOOL.listProjects]: 'List projects',
  [TOOL.getProject]: 'Read a project',
  [TOOL.listDeployments]: 'List deployments',
  [TOOL.getDeployment]: 'Read a deployment',
  [TOOL.getDeploymentBuildLogs]: 'Read the build logs of a deployment',
  [TOOL.getRuntimeLogs]: 'Read runtime logs',
  [TOOL.getAccessToVercelUrl]: 'Create a link that bypasses deployment protection',
  [TOOL.webFetchVercelUrl]: 'Fetch a deployment URL',
  [TOOL.listTeams]: 'List teams',
  [TOOL.checkDomainAvailabilityAndPrice]: 'Check the availability and price of a domain',
  [TOOL.listToolbarThreads]: 'List toolbar comment threads',
  [TOOL.getToolbarThread]: 'Read a toolbar comment thread',
  [TOOL.changeToolbarThreadResolveStatus]: 'Resolve or reopen a toolbar thread',
  [TOOL.replyToToolbarThread]: 'Reply to a toolbar thread',
  [TOOL.editToolbarMessage]: 'Edit a toolbar message',
  [TOOL.addToolbarReaction]: 'React to a toolbar message',
  [TOOL.updateProjectSettings]: 'Change the settings of a project',
  [TOOL.disconnectGit]: 'Disconnect the Git repository of a project',
  [TOOL.upsertEnvVar]: 'Set an environment variable',
  [TOOL.listEnvVars]: 'List environment variables',
  [TOOL.deleteEnvVar]: 'Delete an environment variable',
  [TOOL.listProjectDomains]: 'List the domains of a project',
  [TOOL.addProjectDomain]: 'Attach a domain to a project',
  [TOOL.verifyProjectDomain]: 'Re-check a domain of a project',
  [TOOL.removeProjectDomain]: 'Detach a domain from a project',
  [TOOL.getFirewallConfig]: 'Read the firewall configuration',
  [TOOL.toggleFirewall]: 'Turn the firewall on or off',
  [TOOL.upsertFirewallRule]: 'Set a firewall rule',
  [TOOL.removeFirewallRule]: 'Remove a firewall rule',
  [TOOL.manageIpBlocking]: 'Change an IP blocking rule',
};
