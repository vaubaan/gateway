import type { McpToolDeclaration } from '@vaubaan/shared';

export const availableTools: ReadonlyArray<McpToolDeclaration> = [
  {
    name: 'vps_ssh__exec',
    description: 'Execute a shell command on a registered VPS host.',
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
