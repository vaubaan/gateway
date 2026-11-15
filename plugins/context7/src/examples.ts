/**
 * Representative calls of every tool of the `context7` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Unless a sample names its own, it runs on the one resource of an account,
 * the library index.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { INDEX_DISPLAY_NAME } from './execute.ts';
import { INDEX_REF, SERVICE_ID, TOOL } from './identity.ts';

/** The library index, as discovery returns it. */
export const EXAMPLE_INDEX: Resource = {
  service: SERVICE_ID,
  ref: INDEX_REF,
  displayName: INDEX_DISPLAY_NAME,
};

export const context7Examples: ToolSamples = samplesOn([EXAMPLE_INDEX], {
  [TOOL.resolveLibraryId]: [
    { args: { libraryName: 'Next.js', query: 'app router middleware' } },
    // A mission without a Context7 resource.
    {
      args: { libraryName: 'Next.js', query: 'app router middleware' },
      resources: [],
      expectDenied: true,
    },
  ],
  [TOOL.queryDocs]: [
    { args: { libraryId: '/vercel/next.js', query: 'middleware matcher' } },
    {
      args: {
        libraryId: '/vercel/next.js@v14.3.0',
        query: 'middleware matcher',
        language: 'TypeScript',
      },
    },
    // An upstream alias for `libraryId` : undeclared, refused.
    { args: { libraryName: '/evil/lib', query: 'middleware matcher' }, expectDenied: true },
    { args: { libraryId: '/a/../b', query: 'middleware matcher' }, expectDenied: true },
  ],
});
