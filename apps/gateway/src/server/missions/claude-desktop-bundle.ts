/**
 * The file Claude Desktop installs to reach one mission (ADR
 * mission-key-reaches-an-agent-through-its-own-secret-store): a `.mcpb`, the extension
 * format of Claude Desktop, built per mission and holding no key.
 *
 * Claude Desktop reaches a server on `localhost` only as a local extension speaking
 * MCP on standard input and output. The bundle is a zip of two files:
 *
 *   manifest.json     the extension: named after the mission, one field asked at
 *                     install (`mission_key`, marked `sensitive`: Claude Desktop keeps
 *                     it in the system's secret store), handed to the relay as a variable
 *   server/index.js   the relay: each JSON-RPC line read on standard input is posted to
 *                     the instance's `/mcp` with the key, and the answer written back
 *
 * The relay has no dependency and no state: the door answers each request whole. The
 * manifest follows `MANIFEST.md` of modelcontextprotocol/mcpb, version 0.3 (read
 * 2026-11-27). Nobody ran the bundle in Claude Desktop yet: handbook desktop-app,
 * "Test the first-call path".
 */
import { crc32 } from 'node:zlib';

import { codexServerName } from './bootstrap-kit';

export const MCPB_MANIFEST_VERSION = '0.3';
/** The variables the manifest hands to the relay. */
export const RELAY_URL_ENV = 'VAUBAAN_MCP_URL';
export const RELAY_KEY_ENV = 'VAUBAAN_MISSION_KEY';

export interface ClaudeDesktopBundleInput {
  readonly missionName: string;
  /** The execution door of the instance (`<public_url>/mcp`). */
  readonly endpoint: string;
  /** The gateway's version, as the extension's (semver). */
  readonly version: string;
}

/** `vaubaan-read-code.mcpb`: the file's name, and the extension's without its suffix. */
export function bundleNameOf(missionName: string): string {
  return codexServerName(missionName);
}

/**
 * The manifest wants a semver: the gateway's version without build metadata, or `0.0.0`
 * for a build that carries none (`dev`).
 */
function semverOf(version: string): string {
  const plain = version.split('+')[0] ?? '';
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(plain) ? plain : '0.0.0';
}

export function bundleManifest(input: ClaudeDesktopBundleInput): Record<string, unknown> {
  return {
    manifest_version: MCPB_MANIFEST_VERSION,
    name: bundleNameOf(input.missionName),
    display_name: `Vaubaan · ${input.missionName}`,
    version: semverOf(input.version),
    description: `The Vaubaan mission "${input.missionName}": what this assistant may do on your accounts, through your own gateway at ${input.endpoint}.`,
    author: { name: 'Vaubaan' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          [RELAY_URL_ENV]: input.endpoint,
          [RELAY_KEY_ENV]: '${user_config.mission_key}',
        },
      },
    },
    user_config: {
      mission_key: {
        type: 'string',
        title: 'Mission key',
        description:
          'The key Vaubaan showed once when the mission was created (vbn_live_…). Paste it here; revoke or replace it from the mission.',
        sensitive: true,
        required: true,
      },
    },
  };
}

/**
 * The relay, as the source Claude Desktop runs with its own Node. One line in, one
 * request out; a notification (no `id`) gets no answer; a failure to reach the instance
 * is answered as a JSON-RPC error, so the assistant says why instead of hanging.
 */
export const RELAY_SOURCE = `'use strict';
// Vaubaan relay: MCP on standard input and output, to the gateway's /mcp over HTTP.
const url = process.env.${RELAY_URL_ENV};
const key = process.env.${RELAY_KEY_ENV};

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

async function forward(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const id = request && request.id !== undefined ? request.id : null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + key,
      },
      body: line,
    });
    const text = await response.text();
    if (id === null || text.trim() === '') return;
    try {
      write(JSON.parse(text));
    } catch {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Vaubaan answered ' + response.status + ' with no JSON.' } });
    }
  } catch (err) {
    if (id === null) return;
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'Vaubaan could not be reached at ' + url + ': is it running? (' + (err && err.message) + ')' },
    });
  }
}

let pending = '';
let last = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0, end).trim();
    pending = pending.slice(end + 1);
    // One at a time, in order: an agent's handshake is answered before its first call.
    if (line) last = last.then(() => forward(line));
  }
});
process.stdin.on('end', () => last.then(() => process.exit(0)));
`;

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** A zip archive of stored (uncompressed) files: all a two-file bundle needs. */
export function zipStored(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01, the format's zero
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, directory, end]));
}

/** The `.mcpb` of one mission: the manifest and the relay, no key. */
export function buildClaudeDesktopBundle(input: ClaudeDesktopBundleInput): Uint8Array {
  return zipStored([
    {
      name: 'manifest.json',
      data: Buffer.from(`${JSON.stringify(bundleManifest(input), null, 2)}\n`, 'utf8'),
    },
    { name: 'server/index.js', data: Buffer.from(RELAY_SOURCE, 'utf8') },
  ]);
}
