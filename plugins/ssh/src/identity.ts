/**
 * Identity of the `ssh` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/ssh.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the credential kind's service, the
 * tool names, the resource discovery returns, the slices the classifier
 * emits — is derived from this module.
 *
 * Not to be confused with the remote command `ssh` that the command profiler
 * lists among the commands reaching another host (`command/opaque.ts`) : a
 * command name on the agent's line, not this id.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'ssh';

/** `ssh__` : the prefix of every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** The MCP tool names of the plugin. Declared in `tools.ts`, dispatched in `classify.ts` and `execute.ts`. */
export const TOOL = {
  exec: `${TOOL_PREFIX}exec`,
} as const;
