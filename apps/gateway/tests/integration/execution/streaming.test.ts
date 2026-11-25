/**
 * Streaming on the execution door (spec §4.1 "the gateway forwards streamed
 * responses […]; the decision is made before the stream starts").
 *
 * A plugin whose service answers progressively emits the parts of its result
 * (`ExecuteContext.emitPart`, through the SDK's `streamToolResult`). The door
 * turns each part into a `notifications/progress` frame on the call's event
 * stream — for a caller that sent a `progressToken` — while the plugin keeps
 * reading; the complete result closes the exchange.
 *
 * What is asserted here, over the door's HTTP handler and with the official
 * MCP client in both protocol eras:
 *
 *   - a part reaches the caller while the plugin is still blocked on the
 *     service (nothing is held back until the end);
 *   - at that moment the decision is already taken and counted;
 *   - a refused call is answered by its error alone and reaches no plugin;
 *   - the one audit entry is written when the stream ends: its latency covers
 *     the whole stream, and a stream that broke midway is recorded as
 *     `upstream_error` with the credit still consumed;
 *   - after a first part nothing is replayed, even on a rejected credential;
 *   - a caller that goes away stops the stream at the next part.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  streamToolResult,
  textParts,
  UpstreamAuthError,
  type McpToolContent,
} from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const MODERN_REVISION = '2026-07-28';
const READ = 'depot.read';
const TOOL = 'depot__read_item';
const ARGS = { space: 'scratch' };
/** Long enough to be told apart from scheduling noise, short enough for a unit run. */
const UPSTREAM_PAUSE_MS = 60;

const text = (value: string): McpToolContent => ({ type: 'text', text: value });

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The JSON-RPC messages of an SSE body, as they arrive. */
async function* sseMessages(response: Response): AsyncGenerator<Record<string, unknown>> {
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
      if (data.length > 0) yield JSON.parse(data) as Record<string, unknown>;
      boundary = buffered.search(/\r?\n\r?\n/);
    }
  }
}

/** A 2025-era `tools/call` carrying a progress token, straight to the door's handler. */
function progressCall(
  instance: ExecutionInstance,
  mission: IssuedMission,
  options: { signal?: AbortSignal; args?: Record<string, unknown>; tool?: string } = {},
): Promise<Response> {
  return instance.root.execution.handlers.mcp(
    new Request(`${TEST_PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${mission.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: options.tool ?? TOOL,
          arguments: options.args ?? ARGS,
          _meta: { progressToken: 'p-1' },
        },
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
}

async function connect(
  instance: ExecutionInstance,
  token: string,
  modern: boolean,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${TEST_PUBLIC_URL}/mcp`), {
    fetch: (input, init) => instance.root.execution.handlers.mcp(new Request(input, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'streaming-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {},
  );
  await client.connect(transport);
  return client;
}

describe('streaming on the execution door', () => {
  let instance: ExecutionInstance;
  let mission: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance();
    mission = await instance.issue({ policy: [line(READ, 5)] });
  });
  afterEach(async () => {
    await instance.close();
  });

  const consumed = async (): Promise<number> => {
    const missionLog = await instance.root.store.missionLogs.getByMission(mission.mission.id);
    if (!missionLog) return 0;
    const counters = await instance.root.store.missionLogs.counters(missionLog.id);
    return counters.filter((c) => c.riskId === READ).reduce((sum, c) => sum + c.consumed, 0);
  };
  const auditEntries = () => instance.root.store.audit.list({ missionId: mission.mission.id });
  const auditEntry = async (attempts = 100) => {
    for (let i = 0; i < attempts; i++) {
      const [entry] = await auditEntries();
      if (entry) return entry;
      await pause(10);
    }
    throw new Error('no audit entry was written');
  };

  it('delivers a part while the plugin still reads its service; decision and credit come first', async () => {
    const upstream = gate();
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          yield text('line 1\n');
          await upstream.opened;
          yield text('line 2\n');
        })(),
      ),
    );

    const response = await progressCall(instance, mission);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const messages = sseMessages(response);

    // The first part is in the caller's hands; the plugin is still waiting.
    expect((await messages.next()).value).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'p-1', progress: 1, message: 'line 1\n' },
    });
    // The decision was taken and counted before that byte left…
    expect(await consumed()).toBe(1);
    const missionLog = await instance.root.store.missionLogs.getByMission(mission.mission.id);
    const events = await instance.root.store.missionLogs.listEvents(missionLog?.id ?? '');
    expect(events.map((e) => e.kind)).toEqual(['call-allowed']);
    // …and the audit entry, one per call, waits for the end of the stream.
    expect(await auditEntries()).toHaveLength(0);

    await pause(UPSTREAM_PAUSE_MS);
    upstream.open();
    expect((await messages.next()).value).toMatchObject({
      method: 'notifications/progress',
      params: { progress: 2, message: 'line 2\n' },
    });
    expect((await messages.next()).value).toMatchObject({
      id: 7,
      result: { content: [{ type: 'text', text: 'line 1\nline 2\n' }] },
    });
    expect((await messages.next()).done).toBe(true);

    const entry = await auditEntry();
    expect(entry).toMatchObject({ decision: 'allowed', upstream_error: null, tool: TOOL });
    // The latency is the whole stream's, not the time to the first part.
    expect(entry.kind === 'call' && entry.upstream_latency_ms).toBeGreaterThanOrEqual(
      UPSTREAM_PAUSE_MS - 5,
    );
    expect(await consumed()).toBe(1);
  });

  for (const era of ['2025-era', MODERN_REVISION] as const) {
    it(`an MCP client (${era}) receives the parts as progress, then the complete result`, async () => {
      const upstream = gate();
      instance.depot.script((ctx) =>
        streamToolResult(
          ctx,
          (async function* () {
            yield text('alpha ');
            await upstream.opened;
            yield text('beta');
          })(),
        ),
      );
      const client = await connect(instance, mission.token, era === MODERN_REVISION);
      const seen: { progress: number; message?: string }[] = [];

      const result = await client.callTool(
        { name: TOOL, arguments: ARGS },
        {
          onprogress: (progress) => {
            seen.push({ progress: progress.progress, message: progress.message });
            // Only the first part can be here: the service has not delivered the second.
            if (seen.length === 1) upstream.open();
          },
        },
      );

      expect(seen).toEqual([
        { progress: 1, message: 'alpha ' },
        { progress: 2, message: 'beta' },
      ]);
      expect(result.content).toEqual([{ type: 'text', text: 'alpha beta' }]);
      expect(result.isError ?? false).toBe(false);
      await client.close();
    });
  }

  it('forwards a streamed service body chunk by chunk (textParts over the response body)', async () => {
    const chunks = ['{"rows":[', '1,2,', '3]}'];
    instance.depot.script(async (ctx) => {
      const encoder = new TextEncoder();
      const service = new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
              await pause(5);
            }
            controller.close();
          },
        }),
      );
      if (!service.body) throw new Error('unreachable');
      return streamToolResult(ctx, textParts(service.body));
    });

    const received: unknown[] = [];
    for await (const message of sseMessages(await progressCall(instance, mission))) {
      received.push(message);
    }
    const progress = received.slice(0, -1) as { params: { message: string } }[];
    expect(progress.map((m) => m.params.message).join('')).toBe(chunks.join(''));
    expect(progress.length).toBeGreaterThan(1);
    expect(received.at(-1)).toMatchObject({
      result: { content: [{ type: 'text', text: chunks.join('') }] },
    });
  });

  it('answers one JSON body to a caller that sent no progress token, with the same result', async () => {
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          yield text('a');
          yield text('b');
        })(),
      ),
    );
    const { status, headers, body } = await instance.rpc(mission.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: TOOL, arguments: ARGS },
    });
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('application/json');
    expect(body.result).toEqual({ content: [{ type: 'text', text: 'ab' }] });
  });

  it('sends nothing but the error for a refused call, and reaches no plugin', async () => {
    // Not accepted by the mission: refused on the risk, before the budget.
    const refused = await progressCall(instance, mission, { tool: 'depot__purge' });
    const messages: Record<string, unknown>[] = [];
    for await (const message of sseMessages(refused)) messages.push(message);
    // The exchange is the error alone: no progress frame precedes a refusal.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 7,
      error: { code: -32603, data: { code: 'risk-not-accepted' } },
    });
    expect(instance.depot.calls).toHaveLength(0);
    expect(await consumed()).toBe(0);

    // Exhausted: refused on the budget; still nothing streamed, nothing executed.
    const tight = await instance.issue({ policy: [line(READ, 1)], name: 'Tight' });
    await instance.call(tight, TOOL, ARGS);
    instance.depot.calls.length = 0;
    const exhausted: Record<string, unknown>[] = [];
    for await (const message of sseMessages(await progressCall(instance, tight))) {
      exhausted.push(message);
    }
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ error: { data: { code: 'budget-exhausted' } } });
    expect(instance.depot.calls).toHaveLength(0);
  });

  it('records a stream that breaks midway: allowed, upstream_error, credit consumed, no replay', async () => {
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          yield text('row 1\n');
          yield text('row 2\n');
          await pause(UPSTREAM_PAUSE_MS);
          throw new Error('connection reset by the service near row 3 of table customers');
        })(),
      ),
    );

    const messages: Record<string, unknown>[] = [];
    for await (const message of sseMessages(await progressCall(instance, mission))) {
      messages.push(message);
    }
    expect(messages.map((m) => m.method ?? 'result')).toEqual([
      'notifications/progress',
      'notifications/progress',
      'result',
    ]);
    // The agent reads what happened, and how much it already holds.
    expect(messages.at(-1)).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Upstream error: the stream was interrupted after 2 parts: connection reset by the service near row 3 of table customers',
          },
        ],
      },
    });

    const entry = await auditEntry();
    expect(entry).toMatchObject({
      decision: 'allowed',
      refusal_code: null,
      // Host-built: the service's sentence is not in the audit.
      upstream_error: 'depot stream failed after 2 parts (Error)',
    });
    expect(entry.kind === 'call' && entry.upstream_latency_ms).toBeGreaterThanOrEqual(
      UPSTREAM_PAUSE_MS - 5,
    );
    expect(await consumed()).toBe(1);
    expect(instance.depot.calls).toHaveLength(1);
  });

  it('never replays a call once a part has left, even on a rejected credential', async () => {
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          yield text('partial');
          throw new UpstreamAuthError('token expired mid-stream', 401);
        })(),
      ),
    );
    const body = await (async () => {
      const messages: Record<string, unknown>[] = [];
      for await (const m of sseMessages(await progressCall(instance, mission))) messages.push(m);
      return messages;
    })();
    expect(body.filter((m) => m.method === 'notifications/progress')).toHaveLength(1);
    expect(body.at(-1)).toMatchObject({ result: { isError: true } });
    // One execution: no cache-drop retry, no refresh, and the account is untouched.
    expect(instance.depot.calls).toHaveLength(1);
    expect((await instance.root.store.accounts.getById(instance.account.id))?.status).toBe(
      'active',
    );
    expect(await auditEntry()).toMatchObject({
      decision: 'allowed',
      upstream_error: 'depot stream failed after 1 part, HTTP 401 (UpstreamAuthError)',
    });
  });

  it('still retries a rejected credential when nothing was emitted yet', async () => {
    let attempts = 0;
    instance.depot.scriptRefresh(async () => ({
      kind: 'api-key',
      fields: { token: 'sk-depot-refreshed' },
      metadata: {},
    }));
    instance.depot.script(async (ctx) => {
      attempts += 1;
      // The service's response is opened before the first part: a 401 lands here.
      if (attempts === 1) throw new UpstreamAuthError('expired', 401);
      return streamToolResult(
        ctx,
        (async function* () {
          yield text('ok');
        })(),
      );
    });
    const messages: Record<string, unknown>[] = [];
    for await (const m of sseMessages(await progressCall(instance, mission))) messages.push(m);
    expect(messages.at(-1)).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(attempts).toBe(2);
    expect(await consumed()).toBe(1);
  });

  it('stops the stream when the caller goes away, and says so in the audit', async () => {
    const upstream = gate();
    let emitted = 0;
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          for (;;) {
            emitted += 1;
            yield text(`tick ${emitted}\n`);
            await upstream.opened;
            if (emitted > 50) return;
          }
        })(),
      ),
    );
    const caller = new AbortController();
    const response = await progressCall(instance, mission, { signal: caller.signal });
    const messages = sseMessages(response);
    expect((await messages.next()).value).toMatchObject({ params: { progress: 1 } });

    caller.abort();
    await response.body?.cancel().catch(() => undefined);
    upstream.open();

    const entry = await auditEntry();
    expect(entry).toMatchObject({
      decision: 'allowed',
      upstream_error: 'depot stream stopped after 1 part: the caller was gone',
    });
    // The plugin produced one more part at most before the sink refused it.
    expect(emitted).toBeLessThanOrEqual(2);
    expect(await consumed()).toBe(1);
  });
});

describe('streaming and community telemetry (spec §9)', () => {
  const COLLECTOR_URL = 'https://collector.example.net/rest/v1/plugin_reports?apikey=pk_public';
  let instance: ExecutionInstance;
  let mission: IssuedMission;
  let batches: string[];

  beforeEach(async () => {
    batches = [];
    instance = await executionInstance({
      // plugin-health: what these scenarios are about (a decision report is written
      // for the abandoned call too: the gateway did decide it).
      env: {
        VAUBAAN_TELEMETRY_ENABLED: 'true',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL,
        VAUBAAN_TELEMETRY_LEVEL: 'plugin-health',
      },
      deps: {
        telemetryFetch: async (_input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body === 'string') batches.push(init.body);
          return new Response(null, { status: 201 });
        },
      },
    });
    mission = await instance.issue({ policy: [line(READ, 5)] });
  });
  afterEach(async () => {
    await instance.close();
  });

  /** Everything the collector received, once the queue is empty. */
  const reports = async (): Promise<Record<string, unknown>[]> => {
    for (let guard = 0; guard < 50; guard += 1) {
      await instance.root.telemetry.flush();
      if ((await instance.root.telemetry.overview()).queue.queued === 0) break;
    }
    return batches.flatMap(
      (body) =>
        (JSON.parse(body) as { plugin_health?: Record<string, unknown>[] }).plugin_health ?? [],
    );
  };
  const auditEntry = async () => {
    for (let i = 0; i < 100; i++) {
      const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
      if (entry) return entry;
      await pause(10);
    }
    throw new Error('no audit entry was written');
  };

  it('reports nothing for a call its caller abandoned; the audit entry still says what happened', async () => {
    const upstream = gate();
    let emitted = 0;
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          for (;;) {
            emitted += 1;
            yield text(`tick ${emitted}\n`);
            await upstream.opened;
            if (emitted > 50) return;
          }
        })(),
      ),
    );
    const caller = new AbortController();
    const response = await progressCall(instance, mission, { signal: caller.signal });
    const messages = sseMessages(response);
    expect((await messages.next()).value).toMatchObject({ params: { progress: 1 } });

    caller.abort();
    await response.body?.cancel().catch(() => undefined);
    upstream.open();

    expect(await auditEntry()).toMatchObject({
      decision: 'allowed',
      upstream_error: 'depot stream stopped after 1 part: the caller was gone',
    });
    // A disconnect is not an outcome of the plugin: nothing was queued, nothing left.
    expect((await instance.root.telemetry.overview()).queue.queued).toBe(0);
    expect(await reports()).toEqual([]);

    // The sink is still wired: the next call, served to a caller that stays, is reported.
    instance.depot.script(async () => ({ content: [text('ok')] }));
    await instance.call(mission, TOOL, ARGS);
    expect((await reports()).map((report) => report.outcome)).toEqual(['success']);
  });

  it('reports nothing either when the plugin fails after the caller left (not a timeout of the service)', async () => {
    const started = gate();
    const upstream = gate();
    instance.depot.script(async () => {
      started.open();
      await upstream.opened;
      // What an aborted `fetch` throws; the classifier alone would call it a timeout.
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const caller = new AbortController();
    const pending = progressCall(instance, mission, { signal: caller.signal }).catch(
      () => undefined,
    );
    await started.opened;
    caller.abort();
    upstream.open();
    await pending;

    expect(await auditEntry()).toMatchObject({ decision: 'allowed' });
    expect(await reports()).toEqual([]);
  });

  it('reports once, as an upstream error, when the service breaks the stream of a caller that is still there', async () => {
    instance.depot.script((ctx) =>
      streamToolResult(
        ctx,
        (async function* () {
          yield text('row 1\n');
          throw new Error('connection reset by the service near row 2');
        })(),
      ),
    );
    const messages: Record<string, unknown>[] = [];
    for await (const message of sseMessages(await progressCall(instance, mission))) {
      messages.push(message);
    }
    expect(messages).toHaveLength(2);

    expect(await auditEntry()).toMatchObject({
      decision: 'allowed',
      upstream_error: 'depot stream failed after 1 part (Error)',
    });
    expect((await reports()).map((report) => [report.outcome, report.error_class])).toEqual([
      ['upstream-error', 'unspecified'],
    ]);
  });
});
