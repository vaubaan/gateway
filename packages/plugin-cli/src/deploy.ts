/**
 * `vaubaan-plugin deploy [<archive>] --gateway <url>`: hands a built archive to a gateway
 * (intent "Deploy a plugin to a gateway"), never activates it.
 *
 * The archive goes through the gateway's MCP door (`POST <gateway>/mcp`, stateless) as the
 * `vaubaan__upload_plugin` tool, with the token of a mission on the gateway's Vaubaan
 * account, read from `VAUBAAN_MISSION_TOKEN` (never an argument: it would stay in the
 * shell's history). The gateway accepts it only from a mission whose creator is an
 * administrator, checks it without running its code, and keeps it pending: an
 * administrator activates it, on trial, at the URL printed.
 */

import { readFileSync } from 'node:fs';

import { readArchive } from '@vaubaan/plugin-sdk/archive';

import { ArchiveError } from './archive.ts';
import { isRecord } from '@vaubaan/plugin-sdk';

export const MISSION_TOKEN_ENV = 'VAUBAAN_MISSION_TOKEN';
export const UPLOAD_TOOL = 'vaubaan__upload_plugin';

export interface DeployOptions {
  readonly archive: string;
  readonly gateway: string;
  readonly token: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface DeployResult {
  readonly plugin: string;
  readonly version: string;
  readonly digest: string;
  readonly activationUrl: string;
  readonly next: string;
}

/** The door's URL from the gateway's address (`https://gw.example.com` → `…/mcp`). */
export function doorOf(gateway: string): URL {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new ArchiveError(`--gateway ${gateway} is not a URL (https://gateway.example.com)`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ArchiveError(`--gateway must be https (the token travels with it): ${gateway}`);
  }
  return new URL('/mcp', url);
}

/** The JSON-RPC message of a door answer: a JSON body, or the last `data:` of an event stream. */
async function messageOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    return data.length === 0 ? null : (JSON.parse(data[data.length - 1] as string) as unknown);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** What a refusal says, with its hint (the door sends `data` = the refusal). */
function refusalOf(error: Record<string, unknown>): string {
  const data = isRecord(error.data) ? error.data : {};
  const message = typeof data.message === 'string' ? data.message : String(error.message);
  const hint = typeof data.hint === 'string' ? `\n${data.hint}` : '';
  const code = typeof data.code === 'string' ? ` (${data.code})` : '';
  return `the gateway refused the archive${code}: ${message}${hint}`;
}

/** The tool's answer: `structuredContent`, else the JSON of its first text part. */
function answerOf(result: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const [first] = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  if (isRecord(first) && typeof first.text === 'string') {
    try {
      const parsed: unknown = JSON.parse(first.text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function deployArchive(options: DeployOptions): Promise<DeployResult> {
  if (options.token === undefined || options.token.trim() === '') {
    throw new ArchiveError(
      `${MISSION_TOKEN_ENV} is not set: the token of a mission on the gateway's Vaubaan account, issued by an administrator`,
    );
  }
  const door = doorOf(options.gateway);
  const bytes = readFileSync(options.archive);
  // Refuse locally what the gateway would refuse, before sending 16 MB.
  const { manifest } = readArchive(bytes);
  const response = await (options.fetch ?? fetch)(door, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${options.token.trim()}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: UPLOAD_TOOL,
        arguments: { archive_base64: Buffer.from(bytes).toString('base64') },
      },
    }),
    redirect: 'error',
  });
  if (response.status === 401) {
    throw new ArchiveError(
      `the gateway does not know this mission token (401): check ${MISSION_TOKEN_ENV}`,
    );
  }
  const message = await messageOf(response);
  if (!isRecord(message)) {
    throw new ArchiveError(
      `the gateway answered ${response.status} without an MCP message: is ${door.origin} a Vaubaan gateway?`,
    );
  }
  if (isRecord(message.error)) throw new ArchiveError(refusalOf(message.error));
  const result = isRecord(message.result) ? message.result : {};
  const answer = answerOf(result);
  if (result.isError === true || answer === null || typeof answer.activation_url !== 'string') {
    const said = answer !== null ? JSON.stringify(answer) : JSON.stringify(result);
    throw new ArchiveError(`the gateway did not take the archive: ${said}`);
  }
  return {
    plugin: typeof answer.plugin === 'string' ? answer.plugin : manifest.id,
    version: typeof answer.version === 'string' ? answer.version : manifest.version,
    digest: typeof answer.digest === 'string' ? answer.digest : '',
    activationUrl: answer.activation_url,
    next: typeof answer.next === 'string' ? answer.next : '',
  };
}
