/**
 * MCP tools of the `ssh` service.
 *
 * One tool : `ssh__exec`. The host is a mission resource named by its ref
 * (hostname or IP) ; it may be omitted when the mission holds a single SSH
 * host. The command line is classified by `src/classify.ts` before it runs.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

/** Default and ceiling of the `timeout_s` argument, in seconds. */
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 300;

export const sshTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.exec,
    description:
      'Run a shell command on an SSH host of the mission. A simple command on the read allow-list (journalctl, cat, ls, tail, head, grep, pgrep, ps, docker ps/inspect/logs, systemctl status, df, free, uptime, who, ss -tlnp, md5sum, stat — bare command name, known options only) is low-risk ; anything else is a write, and destructive deletes, package changes, service control and sudo need their own accepted risk. Keep the line plain : a command substitution, a here-document, a variable as the command, inline code (bash -c, python -c, eval), ssh, docker exec or su cannot be classified and need every write risk plus the credential-file risk. Output is capped at 1 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description:
            'Resource ref of the host (hostname or IP as discovered on the account). Optional when the mission holds exactly one SSH host.',
        },
        cmd: { type: 'string', description: 'Shell command line to run on the host.' },
        timeout_s: {
          type: 'number',
          description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
        },
      },
      required: ['cmd'],
    },
  },
];
