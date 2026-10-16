/**
 * What each tool of the `vercel` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const vercelToolTitles: Readonly<Record<string, string>> = {
  vercel__search_vercel_documentation: 'Search the Vercel documentation',
  vercel__deploy_to_vercel: 'Deploy the project',
  vercel__list_projects: 'List projects',
  vercel__get_project: 'Read a project',
  vercel__list_deployments: 'List deployments',
  vercel__get_deployment: 'Read a deployment',
  vercel__get_deployment_build_logs: 'Read the build logs of a deployment',
  vercel__get_runtime_logs: 'Read runtime logs',
  vercel__get_access_to_vercel_url: 'Create a link that bypasses deployment protection',
  vercel__web_fetch_vercel_url: 'Fetch a deployment URL',
  vercel__list_teams: 'List teams',
  vercel__check_domain_availability_and_price: 'Check the availability and price of a domain',
  vercel__list_toolbar_threads: 'List toolbar comment threads',
  vercel__get_toolbar_thread: 'Read a toolbar comment thread',
  vercel__change_toolbar_thread_resolve_status: 'Resolve or reopen a toolbar thread',
  vercel__reply_to_toolbar_thread: 'Reply to a toolbar thread',
  vercel__edit_toolbar_message: 'Edit a toolbar message',
  vercel__add_toolbar_reaction: 'React to a toolbar message',
  vercel__update_project_settings: 'Change the settings of a project',
  vercel__upsert_env_var: 'Set an environment variable',
  vercel__list_env_vars: 'List environment variables',
  vercel__delete_env_var: 'Delete an environment variable',
  vercel__list_project_domains: 'List the domains of a project',
  vercel__add_project_domain: 'Attach a domain to a project',
  vercel__verify_project_domain: 'Re-check a domain of a project',
  vercel__remove_project_domain: 'Detach a domain from a project',
  vercel__get_firewall_config: 'Read the firewall configuration',
  vercel__toggle_firewall: 'Turn the firewall on or off',
  vercel__upsert_firewall_rule: 'Set a firewall rule',
  vercel__remove_firewall_rule: 'Remove a firewall rule',
  vercel__manage_ip_blocking: 'Change an IP blocking rule',
};
