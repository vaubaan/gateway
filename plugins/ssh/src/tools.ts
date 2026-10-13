/**
 * MCP tools of the `ssh` provider.
 *
 * One tool : `ssh__exec`. The host is a mission resource named by its ref
 * (hostname or IP) ; it may be omitted when the mission holds a single SSH
 * host. The command line is classified by `src/classify.ts` before it runs.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

export const SSH_EXEC = 'ssh__exec';

/** Default and ceiling of the `timeout_s` argument, in seconds. */
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 300;

export const sshTools: readonly McpToolDeclaration[] = [
  {
    name: SSH_EXEC,
    description:
      'Run a shell command on an SSH host of the mission. Reads on the whitelist (journalctl, cat, ls, tail, head, grep, ps, docker ps/inspect/logs, systemctl status, df, free, uptime, ss -tlnp, md5sum, stat) are low-risk ; anything else is a write, and destructive deletes, package changes, service control and sudo need their own accepted risk. Output is capped at 1 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description:
            'Resource ref of the host (hostname or IP as discovered on the connection). Optional when the mission holds exactly one SSH host.',
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

// ─── legacy v4, deleted in P1.6 ──────────────────────────────────────────────

/**
 * @deprecated legacy v4, deleted in P1.6 — use `sshTools`. The v4 declaration
 * took the host as `host_slug`, the slug of an `ssh_bindings` row.
 */
export const availableTools: ReadonlyArray<McpToolDeclaration> = [
  {
    name: SSH_EXEC,
    description: 'Execute a shell command on a registered SSH host.',
    inputSchema: {
      type: 'object',
      properties: {
        host_slug: {
          type: 'string',
          description: 'The host slug registered for this project (e.g. vps-rp).',
        },
        cmd: { type: 'string', description: 'Shell command to execute.' },
        timeout_s: { type: 'number', description: 'Timeout in seconds (default 30, max 300).' },
      },
      required: ['host_slug', 'cmd'],
    },
  },
] as const;
