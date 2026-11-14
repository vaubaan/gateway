/**
 * `/mcp/manage` — the management door, retired on 2026-11-14 (ADR
 * platform-management-is-a-plugin-on-the-execution-door). Every method answers
 * 404 with a JSON hint saying where the same tools are now, so that an MCP
 * client configured for the old door tells its person what to change.
 *
 * Pure: it reads nothing of the request and needs no instance.
 */
import { EXECUTION_DOOR_PATH } from '../missions';

const HTTP_NOT_FOUND = 404;

/** What the old door answers, whatever was asked. */
export const RETIRED_MANAGEMENT_DOOR_HINT = {
  error: 'management-door-retired',
  message:
    'This gateway has no management door any more: the tools that prepared missions are the `vaubaan__*` tools of the execution door.',
  hint: `Connect the Vaubaan account in Accounts, create a mission on it (the "platform management" mission), and give its key to the agent: it calls \`vaubaan__list_my_accounts\`, \`vaubaan__issue_mission\` and the others on ${EXECUTION_DOOR_PATH}, with that key as its bearer.`,
} as const;

export function retiredManagementDoorResponse(): Response {
  return new Response(JSON.stringify(RETIRED_MANAGEMENT_DOOR_HINT), {
    status: HTTP_NOT_FOUND,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
