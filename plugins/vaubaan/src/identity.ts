/**
 * Identity of the `vaubaan` service — the gateway's own management tools — the
 * one place its ids are written.
 *
 * The tool names are the ones the management door published before it was
 * retired (`list_my_accounts`, `issue_mission`, …) and two it never had
 * (`rename_mission`, `edit_mission`), prefixed `vaubaan__`, so an
 * agent instruction written for the door still names the right tool (ADR
 * platform-management-is-a-plugin-on-the-execution-door). The prefix is shared
 * with the host's own tools (`vaubaan__request_permission`): the host routes
 * those by exact name before the registry, and refuses a plugin tool that takes
 * one of their names.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'vaubaan';

export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * The acts, by the name the management door gave them; `rename_mission` and
 * `edit_mission` came after the door (ADR amendment 2026-11-16).
 */
export const ACT = {
  listMyAccounts: 'list_my_accounts',
  getCatalog: 'get_catalog',
  listMyMissions: 'list_my_missions',
  previewPolicy: 'preview_policy',
  issueMission: 'issue_mission',
  renameMission: 'rename_mission',
  editMission: 'edit_mission',
  rotateMissionToken: 'rotate_mission_token',
  revokeMission: 'revoke_mission',
  uploadPlugin: 'upload_plugin',
  pluginStatus: 'plugin_status',
} as const;

export type VaubaanActName = keyof typeof ACT;

/** The MCP tool names, `vaubaan__<act>`. */
export const TOOL = {
  listMyAccounts: `${TOOL_PREFIX}${ACT.listMyAccounts}`,
  getCatalog: `${TOOL_PREFIX}${ACT.getCatalog}`,
  listMyMissions: `${TOOL_PREFIX}${ACT.listMyMissions}`,
  previewPolicy: `${TOOL_PREFIX}${ACT.previewPolicy}`,
  issueMission: `${TOOL_PREFIX}${ACT.issueMission}`,
  renameMission: `${TOOL_PREFIX}${ACT.renameMission}`,
  editMission: `${TOOL_PREFIX}${ACT.editMission}`,
  rotateMissionToken: `${TOOL_PREFIX}${ACT.rotateMissionToken}`,
  revokeMission: `${TOOL_PREFIX}${ACT.revokeMission}`,
  uploadPlugin: `${TOOL_PREFIX}${ACT.uploadPlugin}`,
  pluginStatus: `${TOOL_PREFIX}${ACT.pluginStatus}`,
} as const satisfies Record<VaubaanActName, string>;

/** The act a tool name stands for, or `null` for a name of no tool of this plugin. */
export function actOf(tool: string): VaubaanActName | null {
  for (const [act, name] of Object.entries(TOOL)) {
    if (name === tool) return act as VaubaanActName;
  }
  return null;
}
