/**
 * Shared fixtures of the `google-drive` tests: the drive of one account, an
 * execution context with an access token, and the plugin's own samples
 * (`src/examples.ts`; the coverage kit and the identifier proof run on them).
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { EXAMPLE_DRIVE as alice, EXAMPLE_OTHER_DRIVE as bob } from '../../src/examples.ts';
import { DRIVE_API_BASE, SCOPES } from '../../src/identity.ts';
import { googleDrivePlugin } from '../../src/index.ts';

export { alice, bob };

export const TOKEN = 'ya29.drive-access-token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [alice],
  scopes: readonly string[] = [SCOPES.drive],
): ExecuteContext {
  return {
    credential: {
      kind: 'oauth2',
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes,
      metadata: {},
    },
    fetch,
    resources,
  };
}

/** The path and the query of a recorded call, the query as an object. */
export function requestOf(call: RecordedCall): {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

export const DOC_ID = '1AbCdEfGh_ijk-LmN';

/** Any GET of Drive answers a text file's metadata, then its text. */
export const ANY_DRIVE: MockRoute = {
  url: (url) => url.startsWith(DRIVE_API_BASE) || url.includes('/upload/drive/v3/'),
  respond: (call) =>
    call.url.includes('alt=media')
      ? 'hello'
      : { id: DOC_ID, name: 'a.txt', mimeType: 'text/plain', size: '5', files: [] },
  times: 1000,
};

/** One table for the catalog coverage and the identifier proof: the plugin's `examples`. */
export const SAMPLES: ToolSamples = googleDrivePlugin.examples;
