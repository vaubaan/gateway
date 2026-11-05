/**
 * Shared fixtures of the `outlook` tests: the mailbox of a Microsoft 365
 * account (its zoning lists filled), an execution context with a brokered
 * access token, routes of Microsoft Graph, and the plugin's own `examples`
 * (`src/examples.ts`), which the coverage kit and the identifier proof both
 * run on.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import {
  ACCOUNT,
  ATTACHMENT,
  CALENDAR,
  DRAFT,
  EVENT,
  EXAMPLE_MAILBOX,
  FOLDER,
  MAILBOX,
  MESSAGE,
} from '../../src/examples.ts';
import { GRAPH_API_BASE } from '../../src/identity.ts';
import { outlookPlugin } from '../../src/index.ts';

// The ids and the mailbox the plugin's `examples` run on (`src/examples.ts`).
export { ACCOUNT, ATTACHMENT, CALENDAR, DRAFT, EVENT, FOLDER, MAILBOX, MESSAGE };

export const mailbox: Resource = EXAMPLE_MAILBOX;

export const TOKEN = 'eyJ0eXAiOiJKV1QiLCJub25jZSI6.brokered-access-token';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [mailbox],
  scopes: readonly string[] = [],
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

export function graphUrl(path: string): string {
  return `${GRAPH_API_BASE}${path}`;
}

/** The method, the path below `/v1.0` and the query of a recorded call. */
export function requestOf(call: RecordedCall): {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname.replace('/v1.0', ''),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

/** A stored draft addressed to bob@contoso.example. */
export const STORED_DRAFT = {
  id: DRAFT,
  isDraft: true,
  toRecipients: [{ emailAddress: { address: 'Bob@Contoso.example' } }],
  ccRecipients: [],
  bccRecipients: [],
};

/** Routes the executors read before they write (the identifier proof needs them). */
export const READ_FIRST: readonly MockRoute[] = [
  // send_draft reads the stored draft.
  {
    method: 'GET',
    url: (url) => /\/me\/messages\/[^/?]+\?/.test(url) && url.includes('isDraft'),
    body: STORED_DRAFT,
  },
  // move_message to a folder id reads the refused folders and the parents.
  {
    method: 'GET',
    url: (url) => /\/me\/mailFolders\/[^/?]+\?/.test(url),
    respond: (call) => {
      const name = new URL(call.url).pathname.split('/').pop() ?? '';
      if (name === 'msgfolderroot') return { id: 'ROOT' };
      if (/^[a-z]+$/.test(name)) return { id: `ID-${name}`, parentFolderId: 'ROOT' };
      return { id: decodeURIComponent(name), parentFolderId: 'ROOT' };
    },
  },
  // get_attachment reads the attachment's description first.
  {
    method: 'GET',
    url: (url) => url.includes('/attachments/') && url.includes('%24select'),
    body: { '@odata.type': '#microsoft.graph.fileAttachment', id: ATTACHMENT, size: 12 },
  },
  // update_event with attendees reads the current ones.
  {
    method: 'GET',
    url: (url) => /\/events\/[^/?]+\?%24select=attendees$/.test(url),
    body: { attendees: [] },
  },
];

/** One table for the catalog coverage and the identifier proof: the plugin's `examples`. */
export const SAMPLES: ToolSamples = outlookPlugin.examples ?? {};
