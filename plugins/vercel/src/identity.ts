/**
 * Identity of the `vercel` provider — the one place its ids and Vercel's own
 * addresses are written.
 *
 * Handbook : docs/handbook/providers/vercel.md.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, in the package name, and in the names of
 * `upstream-tools.json`. Everything else — the plugin id, the data-model
 * provider, the tool names, the resources discovery returns — is derived from
 * this module.
 */

import { toolPrefixFor, type UpstreamMcpServer } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const PROVIDER_ID = 'vercel';

/** `vercel__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(PROVIDER_ID);

/** The Vercel REST API (custom tools, discovery, the check at paste). */
export const VERCEL_API_BASE = 'https://api.vercel.com';

/** The official Vercel MCP server (the rewrapped tools). */
export const VERCEL_MCP_URL = 'https://mcp.vercel.com/';

/**
 * Vercel's MCP server for the SDK's client (`callUpstreamTool`). It answers a
 * bare `tools/call` without a session, which is how the plugin has always
 * called it : `session: 'never'` keeps exactly those requests, and a 400 or
 * 404 stays the `UpstreamHttpError` it was instead of opening a session.
 */
export const VERCEL_MCP_SERVER: UpstreamMcpServer = {
  url: VERCEL_MCP_URL,
  name: 'Vercel MCP server',
  session: 'never',
};

/**
 * The MCP tool names of the plugin : the 18 rewrapped tools of
 * `upstream-tools.json`, then the 14 custom REST tools of `custom-tools.ts`.
 */
export const TOOL = {
  // Rewrapped from mcp.vercel.com.
  searchVercelDocumentation: `${TOOL_PREFIX}search_vercel_documentation`,
  deployToVercel: `${TOOL_PREFIX}deploy_to_vercel`,
  listProjects: `${TOOL_PREFIX}list_projects`,
  getProject: `${TOOL_PREFIX}get_project`,
  listDeployments: `${TOOL_PREFIX}list_deployments`,
  getDeployment: `${TOOL_PREFIX}get_deployment`,
  getDeploymentBuildLogs: `${TOOL_PREFIX}get_deployment_build_logs`,
  getRuntimeLogs: `${TOOL_PREFIX}get_runtime_logs`,
  getAccessToVercelUrl: `${TOOL_PREFIX}get_access_to_vercel_url`,
  webFetchVercelUrl: `${TOOL_PREFIX}web_fetch_vercel_url`,
  listTeams: `${TOOL_PREFIX}list_teams`,
  checkDomainAvailabilityAndPrice: `${TOOL_PREFIX}check_domain_availability_and_price`,
  listToolbarThreads: `${TOOL_PREFIX}list_toolbar_threads`,
  getToolbarThread: `${TOOL_PREFIX}get_toolbar_thread`,
  changeToolbarThreadResolveStatus: `${TOOL_PREFIX}change_toolbar_thread_resolve_status`,
  replyToToolbarThread: `${TOOL_PREFIX}reply_to_toolbar_thread`,
  editToolbarMessage: `${TOOL_PREFIX}edit_toolbar_message`,
  addToolbarReaction: `${TOOL_PREFIX}add_toolbar_reaction`,
  // Custom, on api.vercel.com.
  updateProjectSettings: `${TOOL_PREFIX}update_project_settings`,
  disconnectGit: `${TOOL_PREFIX}disconnect_git`,
  upsertEnvVar: `${TOOL_PREFIX}upsert_env_var`,
  listEnvVars: `${TOOL_PREFIX}list_env_vars`,
  deleteEnvVar: `${TOOL_PREFIX}delete_env_var`,
  listProjectDomains: `${TOOL_PREFIX}list_project_domains`,
  addProjectDomain: `${TOOL_PREFIX}add_project_domain`,
  verifyProjectDomain: `${TOOL_PREFIX}verify_project_domain`,
  removeProjectDomain: `${TOOL_PREFIX}remove_project_domain`,
  getFirewallConfig: `${TOOL_PREFIX}get_firewall_config`,
  toggleFirewall: `${TOOL_PREFIX}toggle_firewall`,
  upsertFirewallRule: `${TOOL_PREFIX}upsert_firewall_rule`,
  removeFirewallRule: `${TOOL_PREFIX}remove_firewall_rule`,
  manageIpBlocking: `${TOOL_PREFIX}manage_ip_blocking`,
} as const;
