/**
 * The app a successful `fly__create_app` created, read from the call
 * (ADR created-resources-join-the-mission). Handbook : docs/handbook/providers/fly.md.
 *
 * Fly's `POST /apps` answers the new app's id and its creation time
 * (`{"id":"z4k69dxd8r31p5mx","created_at":1708631799000}`), not its name : the
 * name is the one the call asked for, already checked by the app-name grammar,
 * and the answer's id confirms the creation. An answer that names another app
 * is not read. The resource is described as discovery describes it, with what
 * the call knows : `app_id` and `network`. The organization and the allowed
 * image prefixes are written by the discovery that follows the call ; until
 * then a write that needs them is refused with "refresh the account's
 * resources".
 */

import { jsonObjectsOf, type McpToolResult, type Resource } from '@vaubaan/plugin-sdk';

import { META } from './call.ts';
import { appName } from './identifiers.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';

/** A Fly app id as the Machines API writes it (`z4k69dxd8r31p5mx`). */
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `ProviderPlugin.createdResources` : the app `create_app` made, or `[]`. */
export function createdFlyResources(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  result: McpToolResult,
): readonly Resource[] {
  if (tool !== TOOL.createApp) return [];
  const name = appName(args.name);
  if (name === null) return [];
  const answer = jsonObjectsOf(result).find((o) => typeof o.id === 'string' && APP_ID.test(o.id));
  if (!answer || (answer.name !== undefined && answer.name !== name)) return [];
  return [
    {
      provider: PROVIDER_ID,
      ref: name,
      displayName: name,
      metadata: {
        [META.appId]: answer.id,
        [META.network]: typeof args.network === 'string' ? args.network : '',
      },
    },
  ];
}
