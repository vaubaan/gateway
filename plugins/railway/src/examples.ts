/**
 * Representative calls of every tool of the `railway` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * The default mission holds one staging project ; a sample that needs the
 * prod project too says so.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const EXAMPLE_PROJECT_STAGING = '00000000-0000-4000-8000-000000000001';
export const EXAMPLE_PROJECT_PROD = '00000000-0000-4000-8000-000000000002';
export const EXAMPLE_SERVICE = '00000000-0000-4000-8000-00000000000a';
export const EXAMPLE_ENV_STAGING = '00000000-0000-4000-8000-0000000000e1';
export const EXAMPLE_ENV_PROD = '00000000-0000-4000-8000-0000000000e2';

/** A staging project, with the service and environment discovery stored. */
export const EXAMPLE_STAGING: Resource = {
  provider: PROVIDER_ID,
  ref: EXAMPLE_PROJECT_STAGING,
  env: 'staging',
  displayName: 'api (staging)',
  metadata: {
    services: [{ id: EXAMPLE_SERVICE, name: 'api' }],
    environments: [{ id: EXAMPLE_ENV_STAGING, name: 'staging' }],
  },
};

/** The prod project of the same service. */
export const EXAMPLE_PROD: Resource = {
  provider: PROVIDER_ID,
  ref: EXAMPLE_PROJECT_PROD,
  env: 'prod',
  displayName: 'api (prod)',
  metadata: {
    services: [{ id: EXAMPLE_SERVICE, name: 'api' }],
    environments: [{ id: EXAMPLE_ENV_PROD, name: 'production' }],
  },
};

const both = [EXAMPLE_STAGING, EXAMPLE_PROD];
const onStaging = { projectId: EXAMPLE_PROJECT_STAGING, environmentId: EXAMPLE_ENV_STAGING };

export const railwayExamples: ToolSamples = samplesOn([EXAMPLE_STAGING], {
  [TOOL.whoami]: [{ args: {} }],
  [TOOL.listProjects]: [{ args: {} }],
  [TOOL.createProject]: [{ args: { name: 'new' } }],
  [TOOL.listServices]: [{ args: { projectId: EXAMPLE_PROJECT_STAGING } }, { args: {} }],
  [TOOL.listDeployments]: [{ args: { projectId: EXAMPLE_PROJECT_STAGING, limit: 10 } }],
  [TOOL.getStatus]: [{ args: { ...onStaging } }],
  [TOOL.getLogs]: [{ args: { ...onStaging, serviceId: EXAMPLE_SERVICE } }],
  [TOOL.redeploy]: [
    { args: { ...onStaging, serviceId: EXAMPLE_SERVICE } },
    {
      args: {
        projectId: EXAMPLE_PROJECT_PROD,
        serviceId: EXAMPLE_SERVICE,
        environmentId: EXAMPLE_ENV_PROD,
      },
      resources: both,
    },
  ],
  [TOOL.acceptDeploy]: [
    { args: { environmentId: EXAMPLE_ENV_STAGING } },
    // two projects, no projectId : resolved through the discovered environments.
    { args: { environmentId: EXAMPLE_ENV_PROD }, resources: both },
    // one project, an environment it does not own : outside the mission.
    { args: { environmentId: EXAMPLE_ENV_PROD }, expectDenied: true },
  ],
  [TOOL.railwayAgent]: [{ args: { ...onStaging, message: 'scale the worker' } }],
  [TOOL.listVariables]: [{ args: { ...onStaging } }],
  [TOOL.upsertVariable]: [{ args: { ...onStaging, name: 'API_KEY', value: 'x' } }],
  [TOOL.upsertVariables]: [
    { args: { ...onStaging, variables: { A: '1' } } },
    { args: { ...onStaging, variables: { A: '1' }, replace: true } },
    // two projects, an environment none of them declares : ambiguous.
    {
      args: { environmentId: 'env-unknown', variables: { A: '1' } },
      resources: both,
      expectDenied: true,
    },
  ],
  [TOOL.deleteVariable]: [{ args: { ...onStaging, name: 'OLD' } }],
});
