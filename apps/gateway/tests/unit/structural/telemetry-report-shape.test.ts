/**
 * Structural test (spec §10 "a telemetry report contains none of the
 * forbidden fields (§9)").
 *
 * Property-based, over the real pipeline: a real composition root on the
 * `:memory:` store, telemetry enabled towards a mocked collector, and a
 * fixture plugin whose `execute` ends in a randomly drawn outcome — results
 * echoing the arguments, error results, and thrown values of every kind
 * carrying arguments, resource refs, tokens and service messages in their
 * message, `name`, `code`, `status` and `cause`.
 *
 * What must hold for everything that reached the collector (URL, headers and
 * body of every request):
 *
 *   1. every report has exactly the keys of its kind (plugin health, decision,
 *      instance profile), at the usage-stats level, the widest one;
 *   2. every value belongs to a universe fixed before the first call: the
 *      plugin's declaration, the build stamp and the closed vocabularies —
 *      so no value can be derived from a call;
 *   3. none of the things spec §9 forbids appears anywhere on the wire:
 *      argument values, argument hashes, resource refs, mission, mission log,
 *      user and account identifiers, the mission tokens and their
 *      holders (a member's id and email, the name of a named token: who is
 *      calling never leaves the instance), the agent label, the caller's
 *      address and user agent, the instance's host name, the service's
 *      messages;
 *   4. one report per call that reached the plugin, none for a call the
 *      gateway refused before it, in order, with the expected outcome class.
 *
 * The generator is seeded: a failure reproduces.
 */
import { fingerprintArguments } from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import {
  createInstanceProfile,
  DECISION_GATES,
  DECISION_OUTCOMES,
  DECISION_REPORT_KEYS,
  INSTANCE_PROFILE_KEYS,
  type InstanceProfileInput,
  DURATION_BUCKETS,
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
} from '../../support/execution/testing';

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
  const message = rng.poison('service-message');
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

/**
 * This file boots an instance and runs a random pipeline per seed, about 3 s idle: past the 5 s default on a loaded machine (several
 * worktrees testing at once), never through an assertion.
 */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

describe(
  'structural: a telemetry report contains none of the forbidden fields (spec §9)',
  { timeout: HEAVY_TEST_TIMEOUT_MS },
  () => {
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
          line('depot[staging].write', 100_000, {
            rate_limit: { max: 100_000, window_seconds: 60 },
          }),
          line('depot[prod].write', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
          line('depot.purge', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
          line('depot.profile', 100_000, { rate_limit: { max: 100_000, window_seconds: 60 } }),
        ],
        spaces: ['scratch', 'app-staging', 'app-prod'],
      });

      // Three holders on the one mission: its creator, a member and a named token. Each
      // call below is made with one of them, so the attribution the audit keeps (holder
      // id, holder email, token name, token id) travels through every stage that could
      // hand it to telemetry.
      const memberEmail = `${rng.poison('member')}@holder.example`;
      const member = await root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: rng.poison('subject'),
        email: memberEmail,
      });
      const added = await root.missions.team.addMember(instance.ada, mission.mission.id, {
        email: memberEmail,
      });
      if (!added.ok) throw new Error(`add refused: ${added.reason}`);
      const memberToken = await root.missions.team.generateToken(member, mission.mission.id);
      const tokenName = `runner ${rng.poison('named').replace(/[^A-Za-z0-9]/g, '')}`;
      const namedToken = await root.missions.team.createNamedToken(
        instance.ada,
        mission.mission.id,
        tokenName,
      );
      if (!memberToken.ok || !namedToken.ok) throw new Error('token refused');
      const holders = [
        mission,
        { ...mission, token: memberToken.token.secret, prefix: memberToken.token.prefix },
        { ...mission, token: namedToken.token.secret, prefix: namedToken.token.prefix },
      ];
      const callsPerHolder = holders.map(() => 0);

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
          case 'duration_bucket':
            return (DURATION_BUCKETS as readonly unknown[]).includes(value);
          case 'error_class':
            return (
              value === null ||
              (typeof value === 'string' &&
                (allowedErrorClasses.has(value) ||
                  REPORT_FIELD_PATTERNS.httpErrorClass.test(value)))
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
        instance.account.id,
        instance.account.displayName,
        DEPOT_API_KEY,
        new URL(TEST_PUBLIC_URL).host,
        ...instance.resources.flatMap((r) => [r.id, r.ref]),
        // Who holds the tokens, and the tokens themselves.
        member.id,
        member.subject,
        memberEmail,
        tokenName,
        ...holders.flatMap((holder) => [holder.token, holder.prefix]),
        ...(await root.store.missions.listTokens(mission.mission.id)).map((token) => token.id),
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
          const body = await instance.call(rng.pick(holders), rng.pick(SPACE_TOOLS), args, headers);
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
        const holder = rng.int(holders.length);
        callsPerHolder[holder] = (callsPerHolder[holder] ?? 0) + 1;
        const answer = await instance.call(holders[holder] ?? mission, tool, args, headers);
        expect(
          depot.calls.length,
          `iteration ${i}: ${tool} did not reach the plugin: ${answer.error?.message}`,
        ).toBe(before + 1);
        expected.push({ tool, ...drawn.expected });
      }

      // The mission log exists by now: its id is forbidden too.
      const missionLog = await root.store.missionLogs.getByMission(mission.mission.id);
      if (missionLog) forbidden.add(missionLog.id);

      await root.telemetry.profileNow();
      let overview = await root.telemetry.overview();
      for (let guard = 0; overview.queue.queued > 0 && guard < ITERATIONS; guard += 1) {
        await root.telemetry.flush();
        overview = await root.telemetry.overview();
      }

      const bodies = wire.map((request) => JSON.parse(request.body) as Record<string, unknown[]>);
      const reports = bodies.flatMap((body) => body.plugin_health ?? []);
      const decisions = bodies.flatMap((body) => body.decisions ?? []);
      const profiles = bodies.flatMap((body) => body.instance_profiles ?? []);
      // One decision per audited call that has a decision word (allowed, or a refusal code).
      const audited = (await root.store.audit.list({ kind: 'call', missionId: mission.mission.id }))
        .filter((e) => e.kind === 'call')
        .filter((e) => e.decision === 'allowed' || e.refusal_code !== null);
      expect(decisions).toHaveLength(audited.length);
      expect(profiles).toHaveLength(1);
      expect(overview.queue).toMatchObject({
        queued: 0,
        dropped: 0,
        delivered: expected.length + decisions.length + profiles.length,
      });

      // Every holder made calls, and the instance itself did record who: the property
      // below is about what leaves it, not about attribution being absent.
      expect(callsPerHolder.every((count) => count > 20)).toBe(true);
      const attributed = await root.store.audit.tokenHolderActivity(mission.mission.id, {
        since: mission.mission.createdAt,
        until: null,
      });
      expect(attributed.map((a) => a.holder).sort()).toEqual(
        [instance.ada.id, member.id, tokenName].sort(),
      );

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
        // 1. Exactly the seven keys.
        expect(Object.keys(report as object).sort()).toEqual([...PLUGIN_REPORT_KEYS].sort());
        expect(isPluginReport(report)).toBe(true);
        // 2. Every value from the universe fixed before the first call.
        for (const [key, value] of Object.entries(report as object)) {
          expect(isAllowedValue(key, value), `${key}=${String(value)}`).toBe(true);
        }
      }

      for (const decision of decisions) {
        const d = decision as Record<string, unknown>;
        expect(Object.keys(d)).toEqual([...DECISION_REPORT_KEYS]);
        expect(d.plugin).toBe(depot.plugin.id);
        expect(d.tool === null || declaredTools.includes(String(d.tool))).toBe(true);
        expect((DECISION_OUTCOMES as readonly unknown[]).includes(d.decision)).toBe(true);
        expect((DECISION_GATES as readonly unknown[]).includes(d.gate)).toBe(true);
        expect(d.gateway_version).toBe(root.build.version);
        // Account-scoped risks of the plugin only: never an environment label.
        for (const risk of d.risks as string[]) expect(risk).toMatch(/^depot\.[a-z][a-z0-9-]*$/);
      }
      for (const profile of profiles) {
        expect(Object.keys(profile as object)).toEqual([...INSTANCE_PROFILE_KEYS]);
        expect(createInstanceProfile(profile as InstanceProfileInput)).not.toBeNull();
      }

      // 3. Nothing forbidden anywhere on the wire: URL, headers, body.
      forbidden.add('[staging]').add('[prod]');
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
  },
);
