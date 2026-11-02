/**
 * Community telemetry on a real instance (spec §9, §4.3): the composition
 * root on the `:memory:` store, the fixture plugin `depot`, calls sent to the
 * execution door, and the collector replaced by an injected `fetch` the tests
 * assert on. Nothing here reaches a network.
 *
 * What is pinned: off by default and silent, the default collector URL
 * included; once enabled, reports go to the collector URL in use — the
 * project's published collector by default; the operator's toggle
 * (stored in `instance_config`, audited, read-only when the mounted
 * configuration decides); what a report is emitted for; the validation badge.
 */
import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';
import { isDurationBucket, PLUGIN_REPORT_KEYS } from '@vaubaan/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from '../../../src/server/config';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';
import {
  ENABLED_FIELD,
  PROBLEM_PARAM,
  TELEMETRY_ACTION,
  TELEMETRY_CONFIG_OBJECT_ID,
  TELEMETRY_ENABLED_KEY,
  TELEMETRY_PAGE,
} from '../../../src/server/telemetry';

const COLLECTOR_URL = 'https://collector.example.net/rest/v1/plugin_reports?apikey=pk_public';
const OPERATOR_EMAIL = 'ops@example.com';
const READ = 'depot.read';

interface Rig {
  readonly instance: ExecutionInstance;
  readonly collector: ReturnType<typeof vi.fn>;
  readonly logs: Record<string, unknown>[];
  /** Bodies of the batches POSTed to the collector, flattened. */
  reports(): Record<string, unknown>[];
  /** The batches POSTed to the collector, as sent. */
  bodies(): Record<string, Record<string, unknown>[]>[];
  mission(): Promise<IssuedMission>;
  /** A same-origin form POST of the toggle, carrying an operator session. */
  toggle(enabled: string, options?: { as?: 'operator' | 'user' | 'nobody' }): Promise<Response>;
  drain(): Promise<void>;
}

describe('community telemetry', () => {
  let rig: Rig | null = null;

  afterEach(async () => {
    await rig?.instance.close();
    rig = null;
  });

  async function open(
    env: Record<string, string | undefined> = {},
    respond: (url: URL, init: RequestInit) => Response = () => new Response(null, { status: 201 }),
  ): Promise<Rig> {
    const logs: Record<string, unknown>[] = [];
    const collector = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      respond(new URL(String(input)), init ?? {}),
    );
    const instance = await executionInstance({
      // The plugin-health level unless a test asks for usage-stats (the default of the
      // configuration): the scenarios below count plugin-health reports.
      env: {
        VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
        VAUBAAN_LOG_LEVEL: 'debug',
        VAUBAAN_TELEMETRY_LEVEL: 'plugin-health',
        ...env,
      },
      deps: {
        telemetryFetch: collector as unknown as typeof fetch,
        logWrite: (_level, line) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    const { root } = instance;
    const created: Rig = {
      instance,
      collector,
      logs,
      // The plugin-health reports sent, without their duration bucket (checked, then
      // dropped: a duration is not something a test can pin).
      reports: () =>
        collector.mock.calls.flatMap(([, init]) => {
          if ((init as RequestInit).method !== 'POST') return [];
          const body = JSON.parse(String((init as RequestInit).body)) as {
            plugin_health?: Record<string, unknown>[];
          };
          return (body.plugin_health ?? []).map(({ duration_bucket, ...rest }) => {
            expect(isDurationBucket(duration_bucket)).toBe(true);
            return rest;
          });
        }),
      bodies: () =>
        collector.mock.calls.flatMap(([, init]) =>
          (init as RequestInit).method === 'POST'
            ? [
                JSON.parse(String((init as RequestInit).body)) as Record<
                  string,
                  Record<string, unknown>[]
                >,
              ]
            : [],
        ),
      mission: () => instance.issue({ policy: [line(READ, 1_000)] }),
      async toggle(enabled, options = {}) {
        const as = options.as ?? 'operator';
        const headers: Record<string, string> = {
          'content-type': 'application/x-www-form-urlencoded',
          origin: TEST_PUBLIC_URL,
        };
        if (as !== 'nobody') {
          const user =
            as === 'operator'
              ? await root.store.users.upsertFromIdp({
                  issuer: 'http://idp.test',
                  subject: 'idp|ops',
                  email: OPERATOR_EMAIL,
                })
              : instance.ada;
          const session = await root.auth.sessions.create({
            kind: 'user',
            userId: user.id,
            login: { email: user.email, groups: [] },
          });
          headers.cookie = `${SESSION_COOKIE}=${session.id}`;
        }
        return root.telemetry.handlers.setEnabled(
          new Request(`${TEST_PUBLIC_URL}${TELEMETRY_ACTION}`, {
            method: 'POST',
            headers,
            body: new URLSearchParams({ [ENABLED_FIELD]: enabled }).toString(),
          }),
        );
      },
      async drain() {
        for (let guard = 0; guard < 50; guard += 1) {
          await root.telemetry.flush();
          if ((await root.telemetry.overview()).queue.queued === 0) return;
        }
      },
    };
    rig = created;
    return created;
  }

  async function configAudit(r: Rig) {
    return (await r.instance.root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.object.id === TELEMETRY_CONFIG_OBJECT_ID,
    );
  }

  describe('disabled by default', () => {
    it('makes zero network calls, whatever the calls and the pages do', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL });
      const { instance } = r;
      const mission = await r.mission();

      for (let i = 0; i < 60; i += 1) {
        await instance.call(mission, 'depot__read_item', { space: 'scratch', item: `i${i}` });
      }
      instance.depot.script(async () => {
        throw new Error('provider down');
      });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await instance.root.telemetry.flush();
      expect(await instance.root.telemetry.stats.statusFor('depot')).toBeNull();
      await instance.root.telemetry.stats.refresh();

      expect(r.collector).not.toHaveBeenCalled();
      expect(await instance.root.telemetry.overview()).toMatchObject({
        state: { enabled: false, source: 'default' },
        locked: false,
        client: 'disabled',
        queue: { queued: 0, delivered: 0 },
      });
    });

    it('stays off when the configuration says so explicitly, and the toggle is refused', async () => {
      const r = await open({
        VAUBAAN_TELEMETRY_ENABLED: 'false',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL,
      });
      const response = await r.toggle('true');
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`${TELEMETRY_PAGE}?${PROBLEM_PARAM}=locked`);

      const mission = await r.mission();
      await r.instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();
      expect(r.collector).not.toHaveBeenCalled();
      expect(await r.instance.root.store.config.get(TELEMETRY_ENABLED_KEY)).toBeNull();
      expect(await configAudit(r)).toHaveLength(0);
      expect(await r.instance.root.telemetry.overview()).toMatchObject({
        state: { enabled: false, source: 'config' },
        locked: true,
      });
    });
  });

  describe("the default collector URL (the project's published collector)", () => {
    const reportsUrl = (r: Rig) =>
      r.collector.mock.calls
        .map(([url, init]) => ({ url: String(url), method: (init as RequestInit).method }))
        .filter((call) => call.method === 'POST');

    it('disabled (the default): zero network calls to it', async () => {
      const r = await open();
      const { instance } = r;
      expect(instance.root.config.telemetry.collectorUrl.href).toBe(
        new URL(DEFAULT_TELEMETRY_COLLECTOR_URL).href,
      );
      const mission = await r.mission();
      for (let i = 0; i < 60; i += 1) {
        await instance.call(mission, 'depot__read_item', { space: 'scratch', item: `i${i}` });
      }
      await r.drain();
      await instance.root.telemetry.stats.refresh();

      expect(r.collector).not.toHaveBeenCalled();
      expect(await instance.root.telemetry.overview()).toMatchObject({
        state: { enabled: false, source: 'default' },
        client: 'disabled',
        queue: { queued: 0, delivered: 0 },
      });
    });

    it('enabled by the configuration: reports are sent to it, without a warning', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_ENABLED: 'true' });
      const { instance } = r;
      const mission = await r.mission();
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();

      const posts = reportsUrl(r);
      expect(posts.length).toBeGreaterThan(0);
      for (const post of posts) expect(post.url).toBe(DEFAULT_TELEMETRY_COLLECTOR_URL);
      expect(r.reports()).toEqual([
        expect.objectContaining({ plugin: 'depot', tool: 'depot__read_item', outcome: 'success' }),
      ]);
      expect(
        r.logs.filter((entry) => entry.level === 'warn' && entry.component === 'telemetry'),
      ).toHaveLength(0);
      expect(await instance.root.telemetry.overview()).toMatchObject({
        state: { enabled: true, source: 'config' },
        client: 'sending',
        collectorUrl: DEFAULT_TELEMETRY_COLLECTOR_URL,
        queue: { queued: 0, delivered: 1 },
      });
    });

    it('enabled by the operator: reports are sent to it', async () => {
      const r = await open();
      expect((await r.toggle('true')).headers.get('location')).toBe(TELEMETRY_PAGE);
      const mission = await r.mission();
      await r.instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();

      expect(reportsUrl(r).map((post) => post.url)).toContain(DEFAULT_TELEMETRY_COLLECTOR_URL);
      expect((await r.instance.root.telemetry.overview()).client).toBe('sending');
    });
  });

  describe("the operator's toggle", () => {
    it('is stored in instance_config, audited once per change, and takes effect at once', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL });
      const { instance } = r;
      const mission = await r.mission();
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const on = await r.toggle('true');
      expect(on.status).toBe(303);
      expect(on.headers.get('location')).toBe(TELEMETRY_PAGE);
      expect(await instance.root.store.config.get(TELEMETRY_ENABLED_KEY)).toBe('true');

      await instance.call(mission, 'depot__read_item', { space: 'scratch', item: 'after' });
      await r.drain();
      // Only the call made after the opt-in is reported.
      expect(r.reports()).toEqual([
        {
          plugin: 'depot',
          plugin_version: '0.0.1',
          gateway_version: instance.root.build.version,
          tool: 'depot__read_item',
          outcome: 'success',
          error_class: null,
        },
      ]);

      // Same value again: nothing changes, nothing is audited twice.
      await r.toggle('true');
      const operator = await instance.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'idp|ops',
        email: OPERATOR_EMAIL,
      });
      expect(await configAudit(r)).toMatchObject([
        {
          act: 'config-changed',
          user_id: operator.id,
          object: { type: 'instance-config', id: TELEMETRY_CONFIG_OBJECT_ID },
          before: { enabled: false, source: 'default' },
          after: { enabled: true, source: 'admin' },
        },
      ]);

      await r.toggle('false');
      expect(await configAudit(r)).toHaveLength(2);
      expect((await configAudit(r)).at(-1)).toMatchObject({
        before: { enabled: true, source: 'admin' },
        after: { enabled: false, source: 'admin' },
      });
    });

    it('switching off discards what was queued: nothing leaves afterwards', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL });
      const { instance } = r;
      await r.toggle('true');
      const mission = await r.mission();
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect((await instance.root.telemetry.overview()).queue.queued).toBe(1);

      await r.toggle('false');
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();
      expect(r.collector).not.toHaveBeenCalled();
      expect((await instance.root.telemetry.overview()).queue.queued).toBe(0);
    });

    it('refuses anyone but an operator, a foreign origin and a value that is not a boolean', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL });
      expect((await r.toggle('true', { as: 'nobody' })).status).toBe(401);
      expect((await r.toggle('true', { as: 'user' })).status).toBe(403);
      const invalid = await r.toggle('yes please');
      expect(invalid.headers.get('location')).toBe(`${TELEMETRY_PAGE}?${PROBLEM_PARAM}=invalid`);

      const foreign = await r.instance.root.telemetry.handlers.setEnabled(
        new Request(`${TEST_PUBLIC_URL}${TELEMETRY_ACTION}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://evil.example.org',
          },
          body: `${ENABLED_FIELD}=true`,
        }),
      );
      expect(foreign.status).toBe(403);
      expect(await r.instance.root.store.config.get(TELEMETRY_ENABLED_KEY)).toBeNull();
      expect(await configAudit(r)).toHaveLength(0);
    });

    it('survives a restart: the stored toggle is read at boot', async () => {
      const r = await open({ VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL });
      await r.instance.root.store.config.set(TELEMETRY_ENABLED_KEY, 'true');
      // A fresh settings read, as a boot does.
      expect(await r.instance.root.telemetry.settings.state()).toEqual({
        enabled: true,
        source: 'admin',
      });
      expect(r.instance.root.telemetry.settings.enabledNow()).toBe(true);
    });
  });

  describe('what is reported', () => {
    async function enabled(
      respond?: (url: URL, init: RequestInit) => Response,
    ): Promise<{ r: Rig; mission: IssuedMission }> {
      const r = await open(
        { VAUBAAN_TELEMETRY_ENABLED: 'true', VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL },
        respond,
      );
      return { r, mission: await r.mission() };
    }

    it('one report per call that reached the plugin, none for a call refused before it', async () => {
      const { r, mission } = await enabled();
      const { instance } = r;

      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      // Refused by the gateway: a risk the mission does not hold, then a foreign resource.
      await instance.call(mission, 'depot__purge', { space: 'scratch' });
      await instance.call(mission, 'depot__read_item', { space: 'somewhere-else' });
      await instance.call(mission, 'depot__no_such_tool', {});
      instance.depot.script(async () => ({
        content: [{ type: 'text', text: 'unknown item' }],
        isError: true,
      }));
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      instance.depot.script(async () => {
        throw Object.assign(new Error('HTTP 503 from depot'), { status: 503 });
      });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      instance.depot.script(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'items')");
      });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();

      expect(instance.depot.calls).toHaveLength(4);
      expect(r.reports().map((report) => [report.outcome, report.error_class])).toEqual([
        ['success', null],
        ['classification-error', 'executor_refused'],
        ['upstream-error', 'http_503'],
        ['execution-error', 'type_error'],
      ]);
      for (const report of r.reports()) {
        expect(Object.keys(report)).toEqual(
          PLUGIN_REPORT_KEYS.filter((k) => k !== 'duration_bucket'),
        );
      }
    });

    it('a provider failure a plugin throws with its status is an upstream error, in the report and in the audit', async () => {
      const { r, mission } = await enabled();
      const { instance } = r;
      // What the shipped plugins throw for a failed status that is not 401/403.
      instance.depot.script(async () => {
        throw new UpstreamHttpError(
          'depot PATCH /items/7 500: relation "customers" is locked',
          500,
        );
      });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(body.result?.isError).toBe(true);
      await r.drain();

      expect(r.reports().map((report) => [report.outcome, report.error_class])).toEqual([
        ['upstream-error', 'http_500'],
      ]);
      const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
      expect(entry).toMatchObject({
        decision: 'allowed',
        // Host-built: the status and the class, never the provider's sentence.
        upstream_error: 'depot answered HTTP 500 (UpstreamHttpError)',
      });
    });

    it('reports once per call, after the retries: a refreshed credential is a success', async () => {
      const { r, mission } = await enabled();
      const { instance } = r;
      let attempts = 0;
      instance.depot.script(async () => {
        attempts += 1;
        if (attempts === 1) throw new UpstreamAuthError('token expired', 401);
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      instance.depot.scriptRefresh(async () => ({
        kind: 'api-key',
        fields: { token: 'sk-depot-rotated' },
        metadata: {},
      }));

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(body.error).toBeUndefined();
      expect(attempts).toBe(2);
      await r.drain();
      expect(r.reports().map((report) => report.outcome)).toEqual(['success']);
    });

    it('a credential the provider refuses for good is an upstream error, with no provider text', async () => {
      const { r, mission } = await enabled();
      const { instance } = r;
      instance.depot.script(async () => {
        throw new UpstreamAuthError('the key sk-depot-never-returned was revoked', 401);
      });

      const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(body.error?.data?.code).toBe('connection-unavailable');
      // The connection is now expired: the next call never reaches the plugin.
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.drain();

      expect(r.reports()).toEqual([
        {
          plugin: 'depot',
          plugin_version: '0.0.1',
          gateway_version: instance.root.build.version,
          tool: 'depot__read_item',
          outcome: 'upstream-error',
          error_class: 'credential_rejected',
        },
      ]);
    });

    it('a collector that is down never fails or slows a call', async () => {
      const { r, mission } = await enabled(() => {
        throw new TypeError('fetch failed');
      });
      const body = await r.instance.call(mission, 'depot__read_item', { space: 'scratch' });
      expect(body.error).toBeUndefined();
      await r.instance.root.telemetry.flush();
      expect((await r.instance.root.telemetry.overview()).queue).toMatchObject({
        queued: 1,
        failures: 1,
        delivered: 0,
      });
    });

    it('shows the sample payload with the seven keys and the collector URL without its key', async () => {
      const { r } = await enabled();
      const overview = await r.instance.root.telemetry.overview();
      const sample = (JSON.parse(overview.samplePayload) as { plugin_health: object[] })
        .plugin_health;
      expect(sample).toHaveLength(1);
      expect(Object.keys(sample[0] ?? {})).toEqual([...PLUGIN_REPORT_KEYS]);
      expect(sample[0]).toMatchObject({ plugin: 'depot', outcome: 'success', error_class: null });
      expect(overview.collectorUrl).toBe('https://collector.example.net/rest/v1/plugin_reports');
      expect(overview.collectorKeySet).toBe(true);
      expect(overview.client).toBe('sending');
    });
  });

  describe('the usage-stats level', () => {
    async function usage(): Promise<{ r: Rig; mission: IssuedMission }> {
      const r = await open({
        VAUBAAN_TELEMETRY_ENABLED: 'true',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL,
        VAUBAAN_TELEMETRY_LEVEL: 'usage-stats',
      });
      return { r, mission: await r.mission() };
    }

    const decisionsOf = (r: Rig) => r.bodies().flatMap((body) => body.decisions ?? []);
    const profilesOf = (r: Rig) => r.bodies().flatMap((body) => body.instance_profiles ?? []);

    it('reports one decision per audited call, allowed or refused, with account-scoped risks', async () => {
      const { r, mission } = await usage();
      const { instance } = r;
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await instance.call(mission, 'depot__purge', { space: 'scratch' });
      // Refused without a code (the plugin denies a space outside the mission, a tool
      // no plugin declares): not a decision report.
      await instance.call(mission, 'depot__read_item', { space: 'somewhere-else' });
      await instance.call(mission, 'depot__no_such_tool', {});
      await r.drain();

      const decisions = decisionsOf(r);
      expect(decisions.map((d) => [d.tool, d.decision, d.gate])).toEqual([
        ['depot__read_item', 'allowed', 'none'],
        ['depot__purge', 'risk-not-accepted', 'none'],
      ]);
      for (const decision of decisions) {
        expect(decision.plugin).toBe('depot');
        for (const risk of decision.risks as string[]) expect(risk).toMatch(/^depot\.[a-z.-]+$/);
      }
      // The plugin-health level is part of usage-stats.
      expect(r.reports()).toHaveLength(1);
    });

    it('sends neither decisions nor a profile at the plugin-health level', async () => {
      const r = await open({
        VAUBAAN_TELEMETRY_ENABLED: 'true',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL,
      });
      const mission = await r.mission();
      await r.instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await r.instance.root.telemetry.profileNow();
      await r.drain();
      expect(r.bodies().flatMap((body) => Object.keys(body))).toEqual(['plugin_health']);
    });

    it('queues one profile a day, bucketed, with the stored instance identifier and nothing that names the instance', async () => {
      const { r, mission } = await usage();
      const { instance } = r;
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await instance.call(mission, 'depot__read_item', { space: 'scratch', item: 'b' });
      await instance.root.telemetry.profileNow();
      await instance.root.telemetry.profileNow();
      await r.drain();

      const profiles = profilesOf(r);
      expect(profiles).toHaveLength(1);
      const [profile] = profiles;
      expect(profile?.instance_id).toMatch(/^[0-9a-f]{32}$/);
      expect(profile?.instance_id).toBe(await instance.root.telemetry.instanceId.peek());
      expect(profile).toMatchObject({ calls: '2-5', active_missions: '1' });
      expect(profile?.plugins).toEqual([
        expect.objectContaining({ plugin: 'depot', accounts: '1' }),
      ]);
      const wire = JSON.stringify(r.bodies());
      for (const forbidden of [
        new URL(TEST_PUBLIC_URL).host,
        instance.ada.email,
        instance.ada.id,
        mission.mission.id,
        OPERATOR_EMAIL,
      ]) {
        expect(wire, forbidden).not.toContain(forbidden);
      }
      // The instance identifier travels with the profile only.
      const others = r
        .bodies()
        .flatMap((body) => [...(body.plugin_health ?? []), ...(body.decisions ?? [])]);
      expect(JSON.stringify(others)).not.toContain(String(profile?.instance_id));
    });

    it('shows the exact body of each kind on the Admin overview', async () => {
      const { r } = await usage();
      const overview = await r.instance.root.telemetry.overview();
      expect(overview.level).toBe('usage-stats');
      expect(Object.keys(JSON.parse(overview.samplePayload) as object)).toEqual([
        'plugin_health',
        'decisions',
      ]);
    });
  });

  describe('validation status of a connection', () => {
    it('reads plugin_stats once, caches it, and names the status of the running version', async () => {
      const r = await open(
        { VAUBAAN_TELEMETRY_ENABLED: 'true', VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL },
        (url) =>
          url.pathname.endsWith('/plugin_stats')
            ? Response.json([
                {
                  plugin: 'depot',
                  plugin_version: '0.0.1',
                  reports: 640,
                  success_rate: 0.962,
                  validated: true,
                },
              ])
            : new Response(null, { status: 201 }),
      );
      const { stats } = r.instance.root.telemetry;

      expect(await stats.statusFor(r.instance.connection.provider)).toBeNull();
      await stats.refresh();
      expect(await stats.statusFor(r.instance.connection.provider)).toEqual({
        validated: true,
        reports: 640,
        successRate: 0.962,
      });
      await stats.statusFor(r.instance.connection.provider);
      expect(r.collector).toHaveBeenCalledTimes(1);
    });

    it('shows nothing when the collector has no statistics endpoint', async () => {
      const r = await open(
        { VAUBAAN_TELEMETRY_ENABLED: 'true', VAUBAAN_TELEMETRY_COLLECTOR_URL: COLLECTOR_URL },
        () => new Response('not found', { status: 404 }),
      );
      const { stats } = r.instance.root.telemetry;
      await stats.refresh();
      expect(await stats.statusFor('depot')).toBeNull();
    });
  });
});
