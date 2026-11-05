/**
 * Representative calls of every tool of the `vercel` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Every sample runs on one project ; the environment of a call comes from the
 * slice (`envOf`), so preview and production writes are both sampled. The
 * thread-addressed toolbar writes are refused : a thread cannot be bound to a
 * project.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

/** The one project the samples run on. */
export const EXAMPLE_PROJECT: Resource = {
  provider: PROVIDER_ID,
  ref: 'prj_abc',
  displayName: 'app',
};

const p = { projectId: EXAMPLE_PROJECT.ref };

export const vercelExamples: ToolSamples = samplesOn([EXAMPLE_PROJECT], {
  [TOOL.searchVercelDocumentation]: [{ args: { topic: 'routing' } }],
  [TOOL.listTeams]: [{ args: {} }],
  [TOOL.listProjects]: [{ args: { teamId: 'team_abc' } }],
  [TOOL.checkDomainAvailabilityAndPrice]: [{ args: { names: ['example.com'] } }],
  [TOOL.getProject]: [{ args: { ...p, teamId: 'team_abc' } }, { args: {} }],
  [TOOL.listProjectDomains]: [{ args: p }],
  [TOOL.listDeployments]: [{ args: p }],
  [TOOL.getDeployment]: [{ args: { ...p, idOrUrl: 'dpl_1' } }],
  [TOOL.getDeploymentBuildLogs]: [{ args: { ...p, idOrUrl: 'dpl_1' } }],
  [TOOL.getRuntimeLogs]: [
    { args: { ...p, deploymentId: 'dpl_1' } },
    { args: { ...p, environment: 'production' } },
  ],
  [TOOL.webFetchVercelUrl]: [{ args: { url: 'https://app-git-main.vercel.app/' } }],
  [TOOL.listToolbarThreads]: [{ args: p }],
  [TOOL.getToolbarThread]: [{ args: { ...p, threadId: 'thr_1' }, expectDenied: true }],
  [TOOL.listEnvVars]: [{ args: p }, { args: { ...p, decrypt: true } }],
  [TOOL.deployToVercel]: [{ args: p }, { args: {} }],
  [TOOL.getAccessToVercelUrl]: [{ args: { url: 'https://app-git-main.vercel.app/' } }],
  [TOOL.upsertEnvVar]: [
    { args: { ...p, key: 'K', value: 'v', target: ['preview'] } },
    { args: { ...p, key: 'K', value: 'v' } },
    {
      args: { ...p, key: 'K', value: 'v', target: ['preview', 'staging'] },
      expectDenied: true,
    },
  ],
  [TOOL.deleteEnvVar]: [{ args: { ...p, id: 'env_1' } }],
  [TOOL.updateProjectSettings]: [{ args: { ...p, framework: 'nextjs' } }],
  [TOOL.disconnectGit]: [{ args: p }],
  [TOOL.addProjectDomain]: [{ args: { ...p, name: 'www.example.com' } }],
  [TOOL.verifyProjectDomain]: [{ args: { ...p, domain: 'www.example.com' } }],
  [TOOL.removeProjectDomain]: [{ args: { ...p, domain: 'www.example.com' } }],
  [TOOL.getFirewallConfig]: [{ args: p }],
  [TOOL.toggleFirewall]: [{ args: { ...p, enabled: true } }],
  [TOOL.upsertFirewallRule]: [
    { args: { ...p, name: 'r', active: true, conditionGroup: [], action: { type: 'deny' } } },
  ],
  [TOOL.removeFirewallRule]: [{ args: { ...p, ruleId: 'rule_1' } }],
  [TOOL.manageIpBlocking]: [{ args: { ...p, operation: 'insert', ip: '10.0.0.1' } }],
  // The four thread-addressed writes are refused : a thread cannot be bound to a project.
  [TOOL.changeToolbarThreadResolveStatus]: [
    { args: { ...p, threadId: 'thr_1', resolved: true }, expectDenied: true },
  ],
  [TOOL.replyToToolbarThread]: [
    { args: { ...p, threadId: 'thr_1', markdown: 'x' }, expectDenied: true },
  ],
  [TOOL.editToolbarMessage]: [
    {
      args: { ...p, threadId: 'thr_1', messageId: 'msg_1', markdown: 'x' },
      expectDenied: true,
    },
  ],
  [TOOL.addToolbarReaction]: [
    {
      args: { ...p, threadId: 'thr_1', messageId: 'msg_1', emoji: '+1' },
      expectDenied: true,
    },
  ],
});
