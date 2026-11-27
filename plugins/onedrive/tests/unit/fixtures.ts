/**
 * Shared fixtures of the `onedrive` tests: the drive of one account, an
 * execution context with an access token, and the plugin's own samples
 * (`src/examples.ts`; the coverage kit and the identifier proof run on them).
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { EXAMPLE_DRIVE as alice, EXAMPLE_OTHER_DRIVE as bob } from '../../src/examples.ts';
import { GRAPH_API_BASE, SCOPES } from '../../src/identity.ts';
import { oneDrivePlugin } from '../../src/index.ts';

export { alice, bob };

export const TOKEN = 'eyJ0eXAi.graph-access-token-1234567890';
export const FILE_ID = 'D4648F06C91D9D3D!54927';
export const DOWNLOAD = 'https://public.ch.files.1drv.com/y4mAbC/notes.txt?download=1';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [alice],
  scopes: readonly string[] = [SCOPES.userRead, SCOPES.filesReadWrite],
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
    path: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

/** Any request to Graph answers a text item; its download answers text. */
export const ANY_GRAPH: MockRoute = {
  url: (url) =>
    url.startsWith(GRAPH_API_BASE) || url.startsWith('https://public.ch.files.1drv.com/'),
  respond: (call) =>
    call.url.startsWith(GRAPH_API_BASE)
      ? {
          id: FILE_ID,
          name: 'notes.txt',
          size: 5,
          file: { mimeType: 'text/plain' },
          '@microsoft.graph.downloadUrl': DOWNLOAD,
          value: [],
        }
      : 'hello',
  times: 1000,
};

/** One table for the catalog coverage and the identifier proof: the plugin's `examples`. */
export const SAMPLES: ToolSamples = oneDrivePlugin.examples;
