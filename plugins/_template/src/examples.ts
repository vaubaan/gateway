/**
 * Representative calls of every tool (`ProviderPlugin.examples`) : the samples
 * the plugin's tests run through the kit (`assertCatalogCoverage(plugin)` reads
 * them) and the site classifies when it builds, so the public page shows the
 * slices the classifier really emits (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-05).
 *
 * At least one per tool, realistic, none landing on the fallback. Each names
 * the mission resources it runs on (`samplesOn` sets the default) : the site
 * has no test fixtures. A sample the classifier must refuse says so
 * (`expectDenied`).
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const EXAMPLE_STAGING: Resource = {
  provider: PROVIDER_ID,
  ref: 'ws-stg',
  env: 'staging',
  displayName: 'Staging',
};
export const EXAMPLE_PROD: Resource = {
  provider: PROVIDER_ID,
  ref: 'ws-prd',
  env: 'prod',
  displayName: 'Prod',
};

export const templateExamples: ToolSamples = samplesOn([EXAMPLE_STAGING], {
  [TOOL.listWidgets]: [{ args: { workspace: 'ws-stg' } }, { args: {} }],
  [TOOL.getWidget]: [
    { args: { workspace: 'ws-prd', widget_id: 'w1' }, resources: [EXAMPLE_STAGING, EXAMPLE_PROD] },
    // A workspace the mission does not hold is refused by the classifier.
    { args: { workspace: 'ws-prd', widget_id: 'w1' }, expectDenied: true },
  ],
  [TOOL.updateWidget]: [
    { args: { workspace: 'ws-stg', widget_id: 'w1', name: 'x' } },
    {
      args: { widget_id: 'w1', name: 'x' },
      resources: [EXAMPLE_STAGING, EXAMPLE_PROD],
      expectDenied: true,
    },
  ],
  [TOOL.deleteWidget]: [{ args: { workspace: 'ws-stg', widget_id: 'w1' } }],
});
