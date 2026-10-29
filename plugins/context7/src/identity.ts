/**
 * Identity of the `context7` provider — the one place its ids are written.
 *
 * The plugin id, the data-model provider, the tool names, the resource
 * `discoverResources` returns and the credential field are derived from this
 * module, so a classifier can never emit slices under one provider while the
 * executor reads resources under another. `provider:` and the ids of
 * `risk-catalog.yaml`, and the package name in `package.json`, are the other
 * places the id is written.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const PROVIDER_ID = 'context7';

/** Name of the secret field of the `api-key` credential, declared in `credential.ts`, read in `usage.ts`. */
export const API_KEY_FIELD = 'api_key';

/** `context7__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(PROVIDER_ID);

/**
 * The upstream tool names, as `tools/list` of `mcp.context7.com` answers
 * them (`upstream-tools.json`). The gateway's names are these, prefixed.
 */
export const UPSTREAM_TOOL = {
  resolveLibraryId: 'resolve-library-id',
  queryDocs: 'query-docs',
} as const;

/** The MCP tool names of the plugin : the upstream spelling after the prefix, as Railway does. */
export const TOOL = {
  resolveLibraryId: `${TOOL_PREFIX}${UPSTREAM_TOOL.resolveLibraryId}`,
  queryDocs: `${TOOL_PREFIX}${UPSTREAM_TOOL.queryDocs}`,
} as const;

/**
 * The ref of the one resource of a connection : the library index its key
 * can query. A constant, because no answer of Context7 identifies the
 * teamspace a key belongs to (handbook) ; resources are unique per
 * connection, so two connections each have their own.
 */
export const INDEX_REF = 'docs';
