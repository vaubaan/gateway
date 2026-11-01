/**
 * Manual check of streaming through the STANDALONE build (handbook
 * execution-door, Procedures, "Streaming check"). Not part of the
 * automated suite, never part of the image.
 *
 * The question it answers is about the process shape (ADR
 * docker-image-and-config-format): does a `tools/call` event stream written
 * by the door leave the Next 16 standalone server — and the reverse proxy in
 * front of it — frame by frame, or is it held until the end?
 *
 *   serve   One process: the real composition root on the `:memory:` store,
 *           with the door tests' fixture provider (`depot`), whose `execute`
 *           reads a slow chunked HTTP response from a local stand-in upstream
 *           (never a real provider) and forwards it with the SDK's
 *           `streamToolResult(ctx, textParts(body))`. The root is published
 *           where production code looks for it, then the standalone
 *           `server.js` is started in this process — so the HTTP server, the
 *           route handler and the response path are the image's, and the door
 *           behind them is `root.execution`, as in production. Prints the
 *           mission token and one line per audit entry.
 *
 *   probe   A separate process, the agent's side: over real HTTP it sends a
 *           `tools/call` with a progress token (2025-era JSON-RPC, then the
 *           official MCP client in both eras) and prints when each frame
 *           arrived. Exits non-zero if the frames arrived together. Then it
 *           checks a stream that breaks midway, a refused call, and a caller
 *           that disconnects.
 *
 * From the repository root, after `npm run build --workspace @vaubaan/gateway-app`:
 *
 *   PORT=3917 npx tsx apps/gateway/tests/manual/streaming-check.ts serve
 *   npx tsx apps/gateway/tests/manual/streaming-check.ts probe http://127.0.0.1:3917 <token>
 *
 * Through the reference proxy (deploy/caddy/Caddyfile), point the probe at
 * the proxy's address instead; with Caddy's internal certificate, run the
 * probe with NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { streamToolResult, textParts } from '@vaubaan/plugin-sdk';

import { executionInstance, line } from '../support/execution/testing';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STANDALONE_SERVER = resolve(APP_DIR, '.next/standalone/apps/gateway/server.js');
/** Where `getRoot()` looks (`src/server/compose/root.ts`). */
const ROOT_KEY = Symbol.for('vaubaan.gateway.root');

const CHUNKS = 5;
const CHUNK_INTERVAL_MS = 300;
const BREAK_AFTER_CHUNKS = 2;
const TOOL = 'depot__read_item';
/** Its risk (`depot.purge`) is not in the mission's policy. */
const REFUSED_TOOL = 'depot__purge';
const SPACE = 'scratch';
const MODERN_REVISION = '2026-07-28';
const MCP_PATH = '/mcp';
const AUDIT_POLL_MS = 200;

const say = (text: string): void => void process.stdout.write(`${text}\n`);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ */
/* serve                                                                     */
/* ------------------------------------------------------------------------ */

/** A stand-in upstream: `/ok` sends `CHUNKS` chunks, `/break` cuts the socket after two. */
function standInUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    const breaks = req.url === '/break';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(`chunk ${sent} of ${CHUNKS}\n`);
      if (breaks && sent === BREAK_AFTER_CHUNKS) {
        clearInterval(timer);
        res.destroy();
      } else if (sent === CHUNKS) {
        clearInterval(timer);
        res.end();
      }
    }, CHUNK_INTERVAL_MS);
    res.on('close', () => {
      clearInterval(timer);
      if (sent < CHUNKS && !breaks)
        say(`upstream: the gateway closed the body after ${sent} chunks`);
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

async function serve(): Promise<void> {
  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error(
      `${STANDALONE_SERVER} is missing: run \`npm run build --workspace @vaubaan/gateway-app\` first.`,
    );
  }
  const upstream = await standInUpstream();
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const instance = await executionInstance({ deps: { providerFetch: fetch } });
  instance.depot.script(async (ctx, _tool, args) => {
    const path = args.item === 'break' ? '/break' : '/ok';
    const response = await ctx.fetch(`${upstreamUrl}${path}`);
    if (!response.ok || !response.body) throw new Error(`upstream answered ${response.status}`);
    return streamToolResult(ctx, textParts(response.body));
  });
  const mission = await instance.issue({
    policy: [line('depot.read', 100)],
    name: 'Streaming check',
  });

  // Published before Next boots: the app's own `getRoot()` finds it already there.
  (globalThis as Record<symbol, unknown>)[ROOT_KEY] = Promise.resolve(instance.root);
  createRequire(import.meta.url)(STANDALONE_SERVER);

  say(`standalone server: ${STANDALONE_SERVER}`);
  say(`stand-in upstream: ${upstreamUrl} (${CHUNKS} chunks, one every ${CHUNK_INTERVAL_MS} ms)`);
  say(`token: ${mission.token}`);

  let printed = 0;
  setInterval(() => {
    void instance.root.store.audit.list({ missionId: mission.mission.id }).then((entries) => {
      for (const entry of entries.slice(printed)) {
        if (entry.kind !== 'call') continue;
        say(
          `audit: ${entry.decision}${entry.refusal_code ? ` (${entry.refusal_code})` : ''}` +
            ` label=${entry.agent_label ?? '-'} upstream_latency_ms=${entry.upstream_latency_ms ?? '-'}` +
            ` upstream_error=${entry.upstream_error ?? '-'}`,
        );
      }
      printed = entries.length;
    });
  }, AUDIT_POLL_MS);
}

/* ------------------------------------------------------------------------ */
/* probe                                                                     */
/* ------------------------------------------------------------------------ */

interface Frame {
  readonly atMs: number;
  readonly message: Record<string, unknown>;
}

/** The JSON-RPC messages of an SSE body, each with its arrival time. */
async function* frames(response: Response, t0: number): AsyncGenerator<Frame> {
  if (!response.body) throw new Error('the response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trim())
        .join('');
      if (data.length > 0) {
        yield {
          atMs: Math.round(performance.now() - t0),
          message: JSON.parse(data) as Record<string, unknown>,
        };
      }
      boundary = buffered.search(/\r?\n\r?\n/);
    }
  }
}

function rawCall(
  origin: string,
  token: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'X-Vaubaan-Agent': 'streaming-probe',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
    ...(signal ? { signal } : {}),
  });
}

const describeFrame = (frame: Frame): string => {
  const { message } = frame;
  if (message.method === 'notifications/progress') {
    const params = message.params as { progress: number; message?: string };
    return `progress ${params.progress} ${JSON.stringify(params.message ?? '')}`;
  }
  if (message.error) {
    const error = message.error as { message: string };
    return `error ${JSON.stringify(error.message)}`;
  }
  const result = message.result as { isError?: boolean; content?: { text?: string }[] };
  const body = (result.content ?? []).map((c) => c.text ?? '').join('');
  return `result${result.isError ? ' (isError)' : ''} ${JSON.stringify(body)}`;
};

/** Frames that left the gateway one by one are spread over the upstream's own duration. */
function assertSpread(label: string, arrivals: readonly number[]): void {
  const spread = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
  const expected = (CHUNKS - 2) * CHUNK_INTERVAL_MS;
  if (arrivals.length < CHUNKS || spread < expected) {
    throw new Error(
      `${label}: ${arrivals.length} frames within ${spread} ms — expected ${CHUNKS} progress frames spread over at least ${expected} ms. The response was buffered.`,
    );
  }
  say(`   => ${arrivals.length} progress frames spread over ${spread} ms: not buffered`);
}

async function probe(origin: string, token: string): Promise<void> {
  const progressParams = (item: string): Record<string, unknown> => ({
    name: TOOL,
    arguments: { space: SPACE, item },
    _meta: { progressToken: 'probe' },
  });

  say(`1. 2025-era tools/call with a progress token, raw HTTP, ${origin}`);
  {
    const t0 = performance.now();
    const response = await rawCall(origin, token, progressParams('ok'));
    say(
      `   HTTP ${response.status}, ${response.headers.get('content-type')}, headers after ${Math.round(performance.now() - t0)} ms` +
        `, content-encoding: ${response.headers.get('content-encoding') ?? 'none'}`,
    );
    const arrivals: number[] = [];
    for await (const frame of frames(response, t0)) {
      say(`   +${String(frame.atMs).padStart(5)} ms  ${describeFrame(frame)}`);
      if (frame.message.method === 'notifications/progress') arrivals.push(frame.atMs);
    }
    assertSpread('raw HTTP', arrivals);
  }

  for (const era of ['2025-era', MODERN_REVISION] as const) {
    say(`2. official MCP client (${era}), onprogress`);
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Vaubaan-Agent': 'probe' } },
    });
    const client = new Client(
      { name: 'streaming-probe', version: '1.0.0' },
      era === MODERN_REVISION ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {},
    );
    await client.connect(transport);
    const t0 = performance.now();
    const arrivals: number[] = [];
    const result = await client.callTool(
      { name: TOOL, arguments: { space: SPACE, item: 'ok' } },
      {
        onprogress: (progress) => {
          const atMs = Math.round(performance.now() - t0);
          arrivals.push(atMs);
          say(
            `   +${String(atMs).padStart(5)} ms  progress ${progress.progress} ${JSON.stringify(progress.message ?? '')}`,
          );
        },
      },
    );
    const content = (result.content ?? []) as { text?: string }[];
    say(
      `   +${String(Math.round(performance.now() - t0)).padStart(5)} ms  result ${JSON.stringify(content.map((c) => c.text ?? '').join(''))}`,
    );
    assertSpread(`MCP client ${era}`, arrivals);
    await client.close();
  }

  say('3. a stream the upstream cuts after two chunks');
  {
    const t0 = performance.now();
    for await (const frame of frames(await rawCall(origin, token, progressParams('break')), t0)) {
      say(`   +${String(frame.atMs).padStart(5)} ms  ${describeFrame(frame)}`);
    }
  }

  say('4. a refused call (a risk the mission does not accept) with a progress token');
  {
    const t0 = performance.now();
    const response = await rawCall(origin, token, {
      name: REFUSED_TOOL,
      arguments: { space: SPACE },
      _meta: { progressToken: 'probe' },
    });
    for await (const frame of frames(response, t0)) {
      say(`   +${String(frame.atMs).padStart(5)} ms  ${describeFrame(frame)}`);
    }
  }

  say('5. no progress token: one JSON body');
  {
    const t0 = performance.now();
    const response = await rawCall(origin, token, {
      name: TOOL,
      arguments: { space: SPACE, item: 'ok' },
    });
    const body = (await response.json()) as { result?: { content?: { text?: string }[] } };
    say(
      `   HTTP ${response.status}, ${response.headers.get('content-type')}, body after ${Math.round(performance.now() - t0)} ms: ` +
        JSON.stringify((body.result?.content ?? []).map((c) => c.text ?? '').join('')),
    );
  }

  say('6. the caller disconnects after the first frame');
  {
    const caller = new AbortController();
    const t0 = performance.now();
    const response = await rawCall(origin, token, progressParams('ok'), caller.signal);
    try {
      for await (const frame of frames(response, t0)) {
        say(`   +${String(frame.atMs).padStart(5)} ms  ${describeFrame(frame)}`);
        caller.abort();
      }
    } catch (err) {
      say(`   aborted by the probe (${err instanceof Error ? err.name : 'Error'})`);
    }
    // Leave the server the time to see it and write its audit entry.
    await pause(CHUNKS * CHUNK_INTERVAL_MS);
  }
  say('done: read the `audit:` lines of the serve process.');
}

async function main(): Promise<void> {
  const [command, origin, token] = process.argv.slice(2);
  if (command === 'serve') return serve();
  if (command === 'probe' && origin && token) {
    try {
      await probe(origin.replace(/\/+$/, ''), token);
    } catch (err) {
      if (err instanceof ProtocolError) say(`protocol error: ${JSON.stringify(err.data)}`);
      throw err;
    }
    return;
  }
  throw new Error('usage: streaming-check.ts serve | probe <origin> <mission token>');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
