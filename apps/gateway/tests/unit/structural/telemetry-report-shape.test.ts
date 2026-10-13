/**
 * Structural test (spec §10 "a telemetry report contains none of the
 * forbidden fields (§9)").
 *
 * Property-based, over the real pipeline: a real composition root on the
 * `:memory:` store, telemetry enabled towards a mocked collector, and a
 * fixture plugin whose `execute` ends in a randomly drawn outcome — results
 * echoing the arguments, error results, and thrown values of every kind
 * carrying arguments, resource refs, tokens and provider messages in their
 * message, `name`, `code`, `status` and `cause`.
 *
 * What must hold for everything that reached the collector (URL, headers and
 * body of every request):
 *
 *   1. every report has exactly the six allowed keys;
 *   2. every value belongs to a universe fixed before the first call: the
 *      plugin's declaration, the build stamp and the closed vocabularies —
 *      so no value can be derived from a call;
 *   3. none of the things spec §9 forbids appears anywhere on the wire:
 *      argument values, argument hashes, resource refs, mission, session,
 *      user and connection identifiers, the mission token, the agent label,
 *      the caller's address and user agent, the instance's host name, the
 *      provider's messages;
 *   4. one report per call that reached the plugin, none for a call the
 *      gateway refused before it, in order, with the expected outcome class.
 *
 * The generator is seeded: a failure reproduces.
 */
import { fingerprintArguments } from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import {
  ERROR_CLASSES_BY_OUTCOME,
  isPluginReport,
  PLUGIN_REPORT_KEYS,
  REPORT_FIELD_PATTERNS,
  REPORT_OUTCOMES,
  type ReportOutcome,
} from '@vaubaan/telemetry';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEPOT,
  DEPOT_API_KEY,
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type DepotExecute,
  type ExecutionInstance,
} from '../../../src/server/execution/testing';

const COLLECTOR_HOST = 'collector.example.net';
const COLLECTOR_KEY = 'pk_test_public_key';
const COLLECTOR_URL = `https://${COLLECTOR_HOST}/rest/v1/plugin_reports?apikey=${COLLECTOR_KEY}`;
const ITERATIONS = 400;
const SEEDS = [20261013, 7, 0xc0ffee];

/** mulberry32: small, seeded, good enough to draw test cases. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number): number => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    /** A string that appears nowhere else: if it shows up on the wire, it leaked. */
    poison: (label: string): string =>
      `${label}-${Math.floor(next() * 0xffffffff)
        .toString(16)
        .padStart(8, '0')}${Math.floor(next() * 0xffffffff)
        .toString(16)
        .padStart(8, '0')}`,
  };
}

type Rng = ReturnType<typeof prng>;

interface Wire {
  readonly url: string;
  readonly headers: string;
  readonly body: string;
}

interface DrawnOutcome {
  readonly execute: DepotExecute;
  readonly expected: { outcome: ReportOutcome; error_class: string | null };
  /** Strings the outcome carries that must never reach the collector. */
  readonly poisons: readonly string[];
}

const HTTP_STATUSES = [400, 403, 404, 409, 422, 429, 500, 502, 503] as const;
const NOT_A_STATUS = [0, 99, 600, 99_999, 404.5, Number.NaN, -1] as const;
const NETWORK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'] as const;
const TIMEOUT_CODES = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'] as const;

/** One of the ways a `plugin.execute` can end, with secrets planted wherever an error can hold text. */
function drawOutcome(rng: Rng, args: Readonly<Record<string, unknown>>): DrawnOutcome {
  const message = rng.poison('provider-message');
  const leak = `${message} args=${JSON.stringify(args)} token=${DEPOT_API_KEY}`;
  const poisons = [message];
  const upstream = (errorClass: string) => ({
    outcome: 'upstream-error' as const,
    error_class: errorClass,
  });
  const execution = (errorClass: string) => ({
    outcome: 'execution-error' as const,
    error_class: errorClass,
  });
  const throws = (error: unknown): DepotExecute => {
    return async () => {
      throw error;
    };
  };

  switch (rng.int(13)) {
    case 0:
      return {
        execute: async (_ctx, tool, callArgs) => ({
          content: [{ type: 'text', text: JSON.stringify({ tool, callArgs, leak }) }],
          structuredContent: { leak },
        }),
        expected: { outcome: 'success', error_class: null },
        poisons,
      };
    case 1:
      return {
        execute: async () => ({ content: [{ type: 'text', text: leak }], isError: true }),
        expected: { outcome: 'classification-error', error_class: 'executor_refused' },
        poisons,
      };
    case 2: {
      const status = rng.pick(HTTP_STATUSES);
      return {
        execute: throws(Object.assign(new Error(leak), { status, statusText: leak })),
        expected: upstream(`http_${status}`),
        poisons,
      };
    }
    case 3:
      return {
        execute: throws(new UpstreamAuthError(leak, 403)),
        expected: upstream('http_403'),
        poisons,
      };
    case 4: {
      // A hostile error: free text in every field a careless reporter would copy.
      const name = rng.poison('error-name');
      const code = rng.poison('error-code');
      return {
        execute: throws(
          Object.assign(new Error(leak), { name, code, status: rng.pick(NOT_A_STATUS) }),
        ),
        expected: upstream('unspecified'),
        poisons: [...poisons, name, code],
      };
    }
    case 5:
      return {
        execute: throws(Object.assign(new Error(leak), { status: leak, code: 42 })),
        expected: upstream('unspecified'),
        poisons,
      };
    case 6:
      return {
        execute: throws(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error(leak), { code: rng.pick(NETWORK_CODES) }),
          }),
        ),
        expected: upstream('network'),
        poisons,
      };
    case 7:
      return {
        execute: throws(Object.assign(new Error(leak), { code: rng.pick(TIMEOUT_CODES) })),
        expected: upstream('timeout'),
        poisons,
      };
    case 8:
      return {
        execute: throws(new DOMException(leak, rng.pick(['AbortError', 'TimeoutError']))),
        expected: upstream('timeout'),
        poisons,
      };
    case 9: {
      const [Thrown, errorClass] = rng.pick([
        [TypeError, 'type_error'],
        [RangeError, 'range_error'],
        [ReferenceError, 'reference_error'],
        [SyntaxError, 'syntax_error'],
      ] as const);
      return { execute: throws(new Thrown(leak)), expected: execution(errorClass), poisons };
    }
    case 10:
      return { execute: throws(leak), expected: execution('non_error_throw'), poisons };
    case 11:
      return {
        execute: throws({ message: leak, name: leak, code: leak, status: 500 }),
        expected: upstream('http_500'),
        poisons,
      };
    default:
      return {
        execute: throws(rng.pick([null, undefined, 42, Symbol('x'), () => leak])),
        expected: execution('non_error_throw'),
        poisons,
      };
  }
}

const SPACES = ['scratch', 'app-staging', 'app-prod'] as const;
const LABELLED_SPACES = ['app-staging', 'app-prod'] as const;
const SPACE_TOOLS = ['depot__read_item', 'depot__write_item', 'depot__purge'] as const;

describe('structural: a telemetry report contains none of the forbidden fields (spec §9)', () => {
  let instance: ExecutionInstance | null = null;

  afterEach(async () => {
    await instance?.close();
    instance = null;
  });

  it.each(SEEDS)('holds over %i random pipeline outcomes (seed)', async (seed) => {
    const rng = prng(seed);
    const wire: Wire[] = [];
    instance = await executionInstance({
      env: {
        VAUBAAN_TELEMETRY_ENABLED: 'true',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL,
      },
      deps: {
        telemetryFetch: async (input: string | URL | Request, init?: RequestInit) => {
          wire.push({
            url: String(input),
            headers: JSON.stringify(init?.headers ?? {}),
            body: String(init?.body ?? ''),
          });
          return new Response(null, { status: 201 });
        },
      },
    });
    const { root, depot } = instance;
    const mission = await instance.issue({
      policy: [
        line('depot.read', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
        line('depot[staging].write', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
        line('depot[prod].write', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
        line('depot.purge', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
        line('depot.profile', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
      ],
      spaces: ['scratch', 'app-staging', 'app-prod'],
    });

    // The universe of values a report may contain, fixed before any call.
    const declaredTools = depot.plugin.tools.map((t) => t.name);
    const allowedErrorClasses = new Set<string>(Object.values(ERROR_CLASSES_BY_OUTCOME).flat());
    const isAllowedValue = (key: string, value: unknown): boolean => {
      switch (key) {
        case 'plugin':
          return value === depot.plugin.id;
        case 'plugin_version':
          return value === depot.plugin.version;
        case 'gateway_version':
          return value === root.build.version;
        case 'tool':
          return typeof value === 'string' && declaredTools.includes(value);
        case 'outcome':
          return (REPORT_OUTCOMES as readonly unknown[]).includes(value);
        case 'error_class':
          return (
            value === null ||
            (typeof value === 'string' &&
              (allowedErrorClasses.has(value) || REPORT_FIELD_PATTERNS.httpErrorClass.test(value)))
          );
        default:
          return false;
      }
    };

    // What must never be on the wire, whatever happens.
    const forbidden = new Set<string>([
      mission.mission.id,
      mission.token,
      mission.prefix,
      instance.ada.id,
      instance.ada.email,
      instance.connection.id,
      instance.connection.displayName,
      DEPOT_API_KEY,
      new URL(TEST_PUBLIC_URL).host,
      ...instance.resources.flatMap((r) => [r.id, r.ref]),
    ]);

    const expected: { tool: string; outcome: ReportOutcome; error_class: string | null }[] = [];
    let refusedBeforeThePlugin = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const agentLabel = rng.poison('agent');
      const callerIp = `203.0.113.${rng.int(250) + 1}`;
      const userAgent = rng.poison('user-agent');
      const headers = {
        'x-vaubaan-agent': agentLabel,
        'x-forwarded-for': callerIp,
        'x-real-ip': callerIp,
        'user-agent': userAgent,
      };
      [agentLabel, callerIp, userAgent].forEach((value) => forbidden.add(value));

      // One call in ten is refused by the gateway before the plugin runs.
      if (rng.int(10) === 0) {
        const args = { space: rng.poison('foreign-space'), item: rng.poison('item') };
        Object.values(args).forEach((value) => forbidden.add(value));
        forbidden.add(fingerprintArguments(args));
        depot.script(null);
        const body = await instance.call(mission, rng.pick(SPACE_TOOLS), args, headers);
        expect(body.error, 'a call outside the mission is refused').toBeDefined();
        refusedBeforeThePlugin += 1;
        continue;
      }

      const whoami = rng.int(6) === 0;
      const tool = whoami ? 'depot__whoami' : rng.pick(SPACE_TOOLS);
      const args: Record<string, unknown> = whoami
        ? { note: rng.poison('note') }
        : {
            // A write is accepted on the labelled spaces only (`depot[staging|prod].write`).
            space: rng.pick(tool === 'depot__write_item' ? LABELLED_SPACES : SPACES),
            item: rng.poison('item'),
            query: rng.poison('select'),
          };
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && !(SPACES as readonly string[]).includes(value)) {
          forbidden.add(value);
        }
      }
      forbidden.add(fingerprintArguments(args));

      const drawn = drawOutcome(rng, args);
      drawn.poisons.forEach((value) => forbidden.add(value));
      depot.script(drawn.execute);
      const before = depot.calls.length;
      const answer = await instance.call(mission, tool, args, headers);
      expect(
        depot.calls.length,
        `iteration ${i}: ${tool} did not reach the plugin: ${answer.error?.message}`,
      ).toBe(before + 1);
      expected.push({ tool, ...drawn.expected });
    }

    // The session exists by now: its id is forbidden too.
    const session = await root.store.sessions.getByMission(mission.mission.id);
    if (session) forbidden.add(session.id);

    let overview = await root.telemetry.overview();
    for (let guard = 0; overview.queue.queued > 0 && guard < ITERATIONS; guard += 1) {
      await root.telemetry.flush();
      overview = await root.telemetry.overview();
    }
    expect(overview.queue).toMatchObject({ queued: 0, dropped: 0, delivered: expected.length });

    const reports = wire.flatMap((request) => JSON.parse(request.body) as unknown[]);

    // 4. One report per call that reached the plugin, in order, with the expected class.
    expect(refusedBeforeThePlugin).toBeGreaterThan(10);
    expect(reports).toHaveLength(expected.length);
    expect(
      reports.map((r) => {
        const { tool, outcome, error_class } = r as Record<string, unknown>;
        return { tool, outcome, error_class };
      }),
    ).toEqual(expected);
    // Every outcome class was drawn at least once.
    expect(new Set(expected.map((e) => e.outcome))).toEqual(new Set(REPORT_OUTCOMES));

    for (const report of reports) {
      // 1. Exactly the six keys.
      expect(Object.keys(report as object).sort()).toEqual([...PLUGIN_REPORT_KEYS].sort());
      expect(isPluginReport(report)).toBe(true);
      // 2. Every value from the universe fixed before the first call.
      for (const [key, value] of Object.entries(report as object)) {
        expect(isAllowedValue(key, value), `${key}=${String(value)}`).toBe(true);
      }
    }

    // 3. Nothing forbidden anywhere on the wire: URL, headers, body.
    expect(wire.length).toBeGreaterThan(1);
    const everythingSent = wire.map((w) => `${w.url}\n${w.headers}\n${w.body}`).join('\n');
    const leaked = [...forbidden].filter((value) => everythingSent.includes(value));
    expect(leaked).toEqual([]);
    for (const request of wire) {
      expect(new URL(request.url).host).toBe(COLLECTOR_HOST);
      expect(new URL(request.url).search).toBe('');
      expect(Object.keys(JSON.parse(request.headers) as object).sort()).toEqual([
        'apikey',
        'authorization',
        'content-type',
        'prefer',
        'user-agent',
      ]);
    }
    expect(forbidden.size).toBeGreaterThan(ITERATIONS * 4);
    expect(DEPOT).toBe(depot.plugin.id);
  });
});
