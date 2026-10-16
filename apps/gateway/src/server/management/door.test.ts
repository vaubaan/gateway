/**
 * `ManagementDoor` on stubbed ports: what the door itself answers around a
 * tool — a method that throws, a method the stateless transport does not
 * serve, and an answer that does not match the schema the tool advertises.
 * The door behind the real gate and the real tools is
 * `tests/integration/management/management-door.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { LogLevel } from '../config/types';
import { createLogger, createRedactor } from '../logging';
import { ManagementDoor } from './door';
import type { ManagementAdmission } from './ports';
import type { ManagementTools } from './tools';

const URL_OF_DOOR = 'https://gateway.example.com/mcp/manage';
const SECRET = 'vbn_live_abcdefgh_never-in-a-log';

const admit: ManagementAdmission = async () => ({
  delegation: {
    delegation_id: 'delegation-1',
    user_id: 'user-ada',
    client_id: 'vbn_client_agent',
    scopes: ['mgmt'],
    expires_at: '2026-10-13T09:15:00.000Z',
  },
  client: { ip: '203.0.113.9', user_agent: 'test' },
});

function doorOver(tools: Partial<ManagementTools>) {
  const lines: { level: LogLevel; line: string }[] = [];
  const door = new ManagementDoor({
    admit,
    // Only the methods a test names exist: any other call would throw, and be seen.
    tools: tools as ManagementTools,
    rateLimit: { take: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }) },
    build: { version: '0.0.0-test', commit: 'test' },
    logger: createLogger({
      level: 'info',
      redact: createRedactor([]),
      write: (level, line) => lines.push({ level, line }),
      now: () => new Date('2026-10-13T09:00:00.000Z'),
    }),
  });
  return { door, lines };
}

/** One stateless JSON-RPC exchange, as a 2025-era client sends it. */
function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request(URL_OF_DOOR, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer irrelevant-the-gate-is-stubbed',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

interface ToolCallBody {
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly structuredContent?: Record<string, unknown>;
  };
}

async function callTool(
  door: ManagementDoor,
  name: string,
  args: Record<string, unknown>,
): Promise<NonNullable<ToolCallBody['result']>> {
  const response = await door.handle(rpc('tools/call', { name, arguments: args }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as ToolCallBody;
  if (!body.result) throw new Error(`no result: ${JSON.stringify(body)}`);
  return body.result;
}

describe('ManagementDoor', () => {
  it('a tool that throws is an internal-error tool result, logged with the tool and never with its arguments', async () => {
    const { door, lines } = doorOver({
      revokeMission: async () => {
        throw new Error(`the store lost ${SECRET}`);
      },
    });
    const result = await callTool(door, 'revoke_mission', { mission_id: 'm1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'internal-error',
        message: 'The gateway could not complete this call.',
        hint: 'Read the state again with `list_my_missions` before retrying.',
      },
    });
    // The agent is told nothing about the cause.
    expect(JSON.stringify(result)).not.toContain('the store lost');
    const failure = lines.find((entry) => entry.line.includes('management tool failed'));
    expect(failure?.level).toBe('error');
    expect(failure?.line).toContain('"tool":"revoke_mission"');
    expect(failure?.line).toContain('"delegation_id":"delegation-1"');
    expect(lines.some((entry) => entry.line.includes('"msg":"tools/call"'))).toBe(false);
  });

  it('a stateless exchange is a POST: GET and DELETE of a 2025-era client are 405', async () => {
    const { door } = doorOver({});
    for (const method of ['GET', 'DELETE']) {
      const response = await door.handle(
        new Request(URL_OF_DOOR, {
          method,
          headers: { accept: 'application/json, text/event-stream' },
        }),
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(await response.json()).toMatchObject({ error: { code: -32000 } });
    }
  });

  it('an answer that does not match the advertised schema is refused by the SDK after the tool ran — and leaves a trace without any value', async () => {
    // What `output-schemas.ts` exists to prevent, shown on a tool that reveals nothing.
    const { door, lines } = doorOver({
      revokeMission: async () => ({
        ok: true,
        data: {
          mission_id: 'm1',
          state: 'revoked',
          tokens_revoked: SECRET,
          already_revoked: false,
        },
      }),
    } as unknown as Partial<ManagementTools>);
    const result = await callTool(door, 'revoke_mission', { mission_id: 'm1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content?.[0]?.text).toContain('Output validation error');

    const trace = lines.find((entry) =>
      entry.line.includes('management tool answer does not match its advertised schema'),
    );
    expect(trace?.level).toBe('error');
    expect(trace?.line).toContain('"tool":"revoke_mission"');
    expect(trace?.line).toContain('tokens_revoked: invalid_type');
    expect(lines.map((entry) => entry.line).join('\n')).not.toContain(SECRET);
  });

  it('an answer that matches is returned as the tool built it, extra keys included', async () => {
    const data = {
      mission_id: 'm1',
      state: 'revoked',
      tokens_revoked: 1,
      already_revoked: false,
      a_key_the_schema_does_not_name: { nested: true },
    };
    const { door, lines } = doorOver({
      revokeMission: async () => ({ ok: true, data }),
    } as unknown as Partial<ManagementTools>);
    const result = await callTool(door, 'revoke_mission', { mission_id: 'm1' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(data);
    expect(lines.some((entry) => entry.level === 'error')).toBe(false);
  });
});
