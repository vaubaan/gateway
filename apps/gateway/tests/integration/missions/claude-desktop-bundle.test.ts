/**
 * The file Claude Desktop installs to reach a mission (ADR
 * mission-key-reaches-an-agent-through-its-own-secret-store; intent "Connect a desktop
 * assistant without editing a config file"): served per mission to its people, a valid
 * archive of a manifest and a relay with no key inside; and the relay, run as Claude
 * Desktop runs it, carries a real MCP exchange to the door.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import {
  RELAY_KEY_ENV,
  RELAY_SOURCE,
  RELAY_URL_ENV,
} from '../../../src/server/missions/claude-desktop-bundle';
import {
  buildTestRoot,
  PUBLIC_URL,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from './support';

/** The files of a zip of stored entries, read from its central directory. */
function unzipStored(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    expect(archive.readUInt16LE(at + 10)).toBe(0); // stored
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const dataAt = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    files.set(name, archive.subarray(dataAt, dataAt + size));
    at += 46 + nameLength;
  }
  return files;
}

/** Runs the relay as Claude Desktop does: the lines on its standard input, its output back. */
async function runRelay(
  script: string,
  url: string,
  key: string,
  messages: readonly unknown[],
): Promise<string> {
  const env = { ...process.env, [RELAY_URL_ENV]: url, [RELAY_KEY_ENV]: key };
  const relay: ChildProcessWithoutNullStreams = spawn(process.execPath, [script], { env });
  const { stdin, stdout } = relay;
  let out = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => (out += chunk));
  const done = new Promise<void>((resolve) => {
    relay.once('close', () => resolve());
  });
  for (const message of messages) stdin.write(`${JSON.stringify(message)}\n`);
  stdin.end();
  await done;
  return out;
}

describe('the Claude Desktop bundle of a mission', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let missionId: string;
  let key: string;
  let http: Server | null = null;
  let folder: string | null = null;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
    const issued = await root.missions.service.issue(seeded.ada, {
      name: 'Read the code',
      accounts: [{ account_id: seeded.github.account.id, trust_levels: { read: 'careful' } }],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    missionId = issued.mission.id;
    key = issued.token.secret;
  });
  afterEach(async () => {
    http?.close();
    http = null;
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = null;
    await root.close();
  });

  async function bundleFor(user = seeded.ada): Promise<Response> {
    return root.missions.handlers.claudeDesktopBundle(
      new Request(`${PUBLIC_URL}/missions/${missionId}/claude-desktop.mcpb`, {
        headers: await sessionHeaders(root, user),
      }),
      missionId,
    );
  }

  it('is served to the people of the mission only, named after it, with no key inside', async () => {
    const anonymous = await root.missions.handlers.claudeDesktopBundle(
      new Request(`${PUBLIC_URL}/missions/${missionId}/claude-desktop.mcpb`),
      missionId,
    );
    expect(anonymous.status).toBe(401);
    expect((await bundleFor(seeded.bob)).status).toBe(404);

    const response = await bundleFor();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="vaubaan-read-the-code.mcpb"',
    );
    const archive = Buffer.from(await response.arrayBuffer());
    expect(archive.toString('latin1')).not.toContain(key);
    const files = unzipStored(archive);
    expect([...files.keys()]).toEqual(['manifest.json', 'server/index.js']);
    expect(files.get('server/index.js')?.toString('utf8')).toBe(RELAY_SOURCE);
    const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}') as {
      manifest_version: string;
      name: string;
      version: string;
      author: { name: string };
      server: { type: string; entry_point: string; mcp_config: { env: Record<string, string> } };
      user_config: { mission_key: { sensitive: boolean; required: boolean; type: string } };
    };
    // The fields MANIFEST.md of modelcontextprotocol/mcpb requires, and the secret field.
    expect(manifest).toMatchObject({
      manifest_version: '0.3',
      name: 'vaubaan-read-the-code',
      author: { name: 'Vaubaan' },
      server: { type: 'node', entry_point: 'server/index.js' },
      user_config: { mission_key: { type: 'string', sensitive: true, required: true } },
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.server.mcp_config.env).toEqual({
      [RELAY_URL_ENV]: `${PUBLIC_URL}/mcp`,
      [RELAY_KEY_ENV]: '${user_config.mission_key}',
    });
  });

  it('the relay, run as Claude Desktop runs it, carries the handshake and a tool listing to the door', async () => {
    // The door behind a real HTTP listener, as the instance serves it.
    http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string' && name !== 'host') headers.set(name, value);
        }
        void root.execution.handlers
          .mcp(
            new Request(`${PUBLIC_URL}/mcp`, {
              method: req.method ?? 'POST',
              headers,
              body: Buffer.concat(chunks),
            }),
          )
          .then(async (answer) => {
            res.writeHead(answer.status, Object.fromEntries(answer.headers));
            res.end(Buffer.from(await answer.arrayBuffer()));
          });
      });
    });
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;

    folder = mkdtempSync(join(tmpdir(), 'vaubaan-relay-'));
    const script = join(folder, 'index.js');
    writeFileSync(script, RELAY_SOURCE);
    const out = await runRelay(script, `http://127.0.0.1:${port}/mcp`, key, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-desktop-stand-in', version: '0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);

    const answers = out
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: number;
            result?: { instructions?: string; tools?: { name: string }[] };
          },
      );
    // One answer per request, in order; the notification gets none.
    expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
    expect(answers[0]?.result?.instructions).toContain('Vaubaan mission "Read the code"');
    expect(answers[1]?.result?.tools?.map((tool) => tool.name)).toContain('github__list_branches');
  });

  it('the relay answers an error the assistant can show when the instance is not running', async () => {
    folder = mkdtempSync(join(tmpdir(), 'vaubaan-relay-'));
    const script = join(folder, 'index.js');
    writeFileSync(script, RELAY_SOURCE);
    const out = await runRelay(script, 'http://127.0.0.1:9/mcp', key, [
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    ]);
    const answer = JSON.parse(out.trim()) as { id: number; error?: { message: string } };
    expect(answer.id).toBe(7);
    expect(answer.error?.message).toContain('could not be reached');
    expect(out).not.toContain(key);
  });
});
