/**
 * Classifier of the `vaubaan` service: `(tool, args) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7.
 * Handbook : docs/handbook/services/vaubaan.md.
 *
 * Pure: no IO, no clock. The account carries no resource, so no call names
 * one; every slice is placed on the plugin's own data model:
 *
 *   list_my_accounts    vaubaan.account[*].R
 *   preview_policy         vaubaan.account[*].R          (reads the authority, writes nothing)
 *   get_catalog            vaubaan.catalog[<service>].R
 *   list_my_missions       vaubaan.mission[<id> | *].R
 *   issue_mission          vaubaan.mission[*].issue.W
 *   rotate_mission_token   vaubaan.mission[<id>].token.W
 *   revoke_mission         vaubaan.mission[<id>].revoke.W
 *
 * The arguments are refused here only where the slice needs them (an undeclared
 * argument, a missing or malformed id); the host reads every argument again with
 * its own schemas before anything is done.
 */

import {
  ANY_IDENT,
  declaredArgumentsOf,
  identSegment,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { actOf, SERVICE_ID } from './identity.ts';
import { vaubaanTools } from './tools.ts';

/** The longest id the host accepts (`mission_id`, `service`, `account_id`). */
export const MAX_ID_LENGTH = 300;

const DECLARED_ARGUMENTS = declaredArgumentsOf(vaubaanTools);

export const MALFORMED_MISSION_ID = 'mission_id: expected the id of one of the user’s missions.';
export const MALFORMED_SERVICE = 'service: expected a service id, e.g. `github`.';

/** The value as an id: a non-empty string of at most `MAX_ID_LENGTH` characters, or `null`. */
export function idOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

function slice(path: readonly SliceSegment[], action: 'R' | 'W'): Slice {
  return { service: SERVICE_ID, path, action };
}

const name = (value: string): SliceSegment => ({ kind: 'name', value });

export function classifyVaubaan(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): ClassifyOutcome {
  const act = actOf(tool);
  if (act === null) return { denied: `unknown tool '${tool}'` };
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
  if (undeclared !== null) return { denied: undeclared };

  switch (act) {
    case 'listMyAccounts':
    case 'previewPolicy':
      return { slices: [slice([name('account'), ANY_IDENT], 'R')] };
    case 'getCatalog': {
      const service = idOf(args.service);
      if (service === null) return { denied: MALFORMED_SERVICE };
      return { slices: [slice([name('catalog'), identSegment(service)], 'R')] };
    }
    case 'listMyMissions': {
      if (args.mission_id === undefined) {
        return { slices: [slice([name('mission'), ANY_IDENT], 'R')] };
      }
      const id = idOf(args.mission_id);
      if (id === null) return { denied: MALFORMED_MISSION_ID };
      return { slices: [slice([name('mission'), identSegment(id)], 'R')] };
    }
    case 'issueMission':
      return { slices: [slice([name('mission'), ANY_IDENT, name('issue')], 'W')] };
    case 'rotateMissionToken':
    case 'revokeMission': {
      const id = idOf(args.mission_id);
      if (id === null) return { denied: MALFORMED_MISSION_ID };
      const verb = act === 'rotateMissionToken' ? 'token' : 'revoke';
      return { slices: [slice([name('mission'), identSegment(id), name(verb)], 'W')] };
    }
  }
}
