/**
 * Identity of the `template` service — the one place its ids are written.
 *
 * A copy of this template changes `SERVICE_ID` here, `service:` and the ids
 * in `risk-catalog.yaml` (the loader refuses a catalog of another service,
 * and `definePlugin` a catalog whose service differs from the plugin id),
 * and the package name in `package.json`.
 * Everything else — the plugin id, the data-model service, the tool names,
 * the resources `discoverResources` returns, the credential field — is
 * derived from this module, so a classifier can never emit slices under one
 * service while the executor filters resources under another.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id : a lowercase slug (`cloudflare-dns`). */
export const SERVICE_ID = 'template';

/** Name of the secret field of the `api-key` credential, declared in `index.ts` and read in `execute.ts`. */
export const API_KEY_FIELD = 'api_key';

const prefix = toolPrefixFor(SERVICE_ID);

/** The MCP tool names, `<prefix><verb>_<noun>`. Declared in `tools.ts`, dispatched in `classify.ts` and `execute.ts`. */
export const TOOL = {
  listWidgets: `${prefix}list_widgets`,
  getWidget: `${prefix}get_widget`,
  updateWidget: `${prefix}update_widget`,
  deleteWidget: `${prefix}delete_widget`,
} as const;
