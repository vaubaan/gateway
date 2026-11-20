/**
 * Mandatory suite of the `upstash-redis` plugin : the SDK kit, the v5
 * classifier conventions (database resolution against mission resources,
 * verb routing of `execute`), environment resolution through the resource
 * label, the credential spec, `execute` and `discoverResources` against
 * `mockFetch`.
 *
 * The per-tool slice expectations live in `classify.test.ts`.
 * No test ever reaches the network : an unmatched request rejects.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  CredentialKindMismatch,
  parseSlice,
  serializeSlice,
  type ExecuteContext,
  type PluginLogger,
  type Resource,
  UpstreamProtocolError,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  mockFetch,
  policyFromMacroActions,
  resourceEnvResolver,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  basicAuthHeader,
  classifyUpstashRedis,
  LIST_DATABASES_NOTE,
  MAX_DISCOVERED_DATABASES,
  redactDatabases,
  upstashAuth,
  upstashRedisCredential,
  upstashRedisPlugin,
  UPSTASH_MANAGEMENT_API,
} from '../../src/index.ts';

const cache: Resource = {
  service: 'upstash-redis',
  ref: 'db-abc-123',
  env: 'staging',
  displayName: 'app-cache',
};
const queue: Resource = {
  service: 'upstash-redis',
  ref: 'db-def-456',
  env: 'prod',
  displayName: 'app-queue',
};
const foreign: Resource = { service: 'github', ref: 'acme/app', displayName: 'acme/app' };

/** How a refusal names a mission holding `cache` alone. */
const ONLY_CACHE =
  'Databases of this mission: app-cache (db-abc-123) — upstash_redis__list_databases lists them.';

const credential = {
  kind: 'api-key' as const,
  fields: { email: 'ops@acme.com', api_key: 'upstash_key_123' },
  metadata: {},
};

const EXPECTED_BASIC = `Basic ${Buffer.from('ops@acme.com:upstash_key_123').toString('base64')}`;

function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [cache],
  logger?: PluginLogger,
): ExecuteContext {
  return { credential, fetch, resources, ...(logger ? { logger } : {}) };
}

const DATABASE_URL = `${UPSTASH_MANAGEMENT_API}/redis/database/db-abc-123`;
const REST_URL = 'https://us1-app-cache.upstash.io';

/** The Management API answer `execute` reads the REST endpoint and token from. */
const databaseRoute = {
  method: 'GET',
  url: DATABASE_URL,
  body: {
    database_id: 'db-abc-123',
    database_name: 'app-cache',
    rest_url: REST_URL,
    rest_token: 'AXxxRestToken',
    read_only_rest_token: 'AXxxReadOnly',
    password: 'pw',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Structural kit
// ─────────────────────────────────────────────────────────────────────────────

describe('upstash-redis plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(upstashRedisPlugin);
    assertNoWildcard(upstashRedisPlugin);
  });

  test('ships peek, write, delete and manage ; key-level writes off prod at Careful ; the fallback in none', () => {
    const actions = upstashRedisPlugin.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['peek', 'write', 'delete', 'manage']);
    for (const a of actions) {
      expect(
        a.entries.some((e) => e.risk_id.includes('uncategorized')),
        `${a.id} must not carry the fallback`,
      ).toBe(false);
    }
    const peek = actions.find((a) => a.id === 'peek')!;
    expect(peek.entries.every((e) => e.risk_id.startsWith('upstash-redis.read-'))).toBe(true);

    const developer = policyFromMacroActions(
      upstashRedisPlugin,
      { peek: 'careful', write: 'careful', delete: 'careful' },
      { envs: ['development', 'staging'] },
    );
    const devRisks = developer.map((e) => e.risk_id);
    expect(devRisks).toEqual(
      expect.arrayContaining([
        'upstash-redis.read-data',
        'upstash-redis[development].write-data',
        'upstash-redis[staging].write-data',
        'upstash-redis[development].delete-data',
      ]),
    );
    // The irreversible flush is left out at Careful ; `manage` is not ticked.
    for (const forbidden of [
      'flush-database',
      'execute-arbitrary',
      'create-database',
      'delete-database',
      'modify-database',
      '[prod]',
    ]) {
      expect(
        devRisks.some((id) => id.includes(forbidden)),
        `developer: ${forbidden}`,
      ).toBe(false);
    }
    const devGate = (id: string) => developer.find((e) => e.risk_id === id)?.gate;
    expect(devGate('upstash-redis[staging].write-data')).toBe('auto');
    expect(devGate('upstash-redis[staging].delete-data')).toBe('approval');

    const operator = policyFromMacroActions(
      upstashRedisPlugin,
      { peek: 'trusting', write: 'trusting', delete: 'trusting', manage: 'trusting' },
      { envs: ['development', 'staging', 'prod'] },
    );
    const gated = operator.filter((e) => e.gate === 'approval').map((e) => e.risk_id);
    expect(gated).toEqual(
      expect.arrayContaining([
        'upstash-redis[development].flush-database',
        'upstash-redis[staging].flush-database',
        'upstash-redis[prod].flush-database',
        'upstash-redis[development].delete-database',
        'upstash-redis[staging].delete-database',
        'upstash-redis[prod].delete-database',
        'upstash-redis[development].modify-database',
        'upstash-redis[staging].modify-database',
        'upstash-redis[prod].modify-database',
        'upstash-redis[prod].delete-data',
        'upstash-redis[prod].execute-arbitrary',
      ]),
    );
    const auto = operator.filter((e) => e.gate === 'auto').map((e) => e.risk_id);
    expect(auto).toContain('upstash-redis[prod].write-data');
    expect(auto).toContain('upstash-redis.create-database');
  });

  // One table for the catalog coverage and for the identifier proof : the plugin's own
  // `examples` (`src/examples.ts`), each sample with its resources.
  const SAMPLES: ToolSamples = upstashRedisPlugin.examples;

  test('every tool classifies to slices the catalog covers, every named risk is reached', () => {
    const report = assertCatalogCoverage(upstashRedisPlugin);
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(upstashRedisPlugin, SAMPLES, {
      resources: [cache, foreign],
      cardinalities: false,
    });
    expect(report.toolsChecked).toBe(21);
    // Every named risk is reached by at least one tool ; no sample lands on
    // the fallback (ADR fallback-risk-only-when-uncategorized).
    const named = upstashRedisPlugin.catalog.risks
      .map((r) => r.id)
      .filter((id) => id !== 'upstash-redis.uncategorized-write');
    expect(report.risksTouched).toEqual(named);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(upstashRedisPlugin, SAMPLES, {
      resources: [cache, foreign],
      context: (fetch, resources) => ctx(fetch, resources),
    });
    expect(report.toolsChecked).toBe(21);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'databaseId',
    ]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Classifier conventions (the per-tool slice expectations are in classify.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyUpstashRedis — database resolution against mission resources', () => {
  const slices = (tool: string, args: Record<string, unknown>, resources: readonly Resource[]) => {
    const out = classifyUpstashRedis(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };

  test('databaseId defaults to the single Upstash resource of the mission', () => {
    expect(slices('upstash_redis__get', { key: 'k' }, [cache, foreign])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[k].R',
    ]);
    expect(slices('upstash_redis__get_database', {}, [cache])).toEqual([
      'upstash-redis.database[db-abc-123].R',
    ]);
    expect(slices('upstash_redis__delete_database', {}, [cache])).toEqual([
      'upstash-redis.account.database[db-abc-123].delete.W',
    ]);
  });

  test('refuses a database the mission does not hold, an ambiguous or missing one, a malformed ref', () => {
    expect(
      classifyUpstashRedis('upstash_redis__get', { databaseId: 'db-other', key: 'k' }, [cache]),
    ).toEqual({
      denied: `upstash-redis database 'db-other' is not a resource of this mission. ${ONLY_CACHE}`,
    });
    expect(classifyUpstashRedis('upstash_redis__get', { key: 'k' }, [cache, queue])).toEqual({
      denied:
        'databaseId: argument missing and the mission touches 2 Upstash databases — name one by its id or its name. ' +
        'Databases of this mission: app-cache (db-abc-123), app-queue (db-def-456) — upstash_redis__list_databases lists them.',
    });
    expect(classifyUpstashRedis('upstash_redis__get', { key: 'k' }, [foreign])).toEqual({
      denied: 'databaseId: argument missing and the mission touches no Upstash database',
    });
    expect(
      classifyUpstashRedis('upstash_redis__get', { databaseId: 'db abc', key: 'k' }, [cache]),
    ).toEqual({ denied: 'databaseId: malformed database ref' });
    expect(
      classifyUpstashRedis('upstash_redis__get', { database_id: 42, key: 'k' }, [cache]),
    ).toEqual({ denied: 'databaseId: malformed database ref' });
  });

  test('databaseId takes a database of the mission by its exact name : the slice names its id', () => {
    expect(
      slices('upstash_redis__get', { databaseId: 'app-queue', key: 'k' }, [cache, queue]),
    ).toEqual(['upstash-redis.database[db-def-456].key-space[k].R']);
    expect(
      slices('upstash_redis__get_database', { database_id: 'app-cache' }, [cache, queue]),
    ).toEqual(['upstash-redis.database[db-abc-123].R']);
    // Exact : no case folding, no trimming, no prefix.
    for (const near of ['App-Cache', ' app-cache', 'app-cache ', 'app']) {
      const out = classifyUpstashRedis('upstash_redis__get', { databaseId: near, key: 'k' }, [
        cache,
      ]);
      expect('denied' in out, near).toBe(true);
    }
    // A name outside the mission, or another service's resource name, is refused.
    expect(
      'denied' in
        classifyUpstashRedis('upstash_redis__get', { databaseId: 'acme/app', key: 'k' }, [
          cache,
          foreign,
        ]),
    ).toBe(true);
  });

  test('a name two mission databases share is refused, asking for the id', () => {
    const twin: Resource = { ...queue, displayName: 'app-cache' };
    expect(
      classifyUpstashRedis('upstash_redis__get', { databaseId: 'app-cache', key: 'k' }, [
        cache,
        twin,
      ]),
    ).toEqual({
      denied:
        "databaseId: 2 Upstash databases of this mission are named 'app-cache' — name one by its id. " +
        'Databases of this mission: app-cache (db-abc-123), app-cache (db-def-456) — upstash_redis__list_databases lists them.',
    });
    // The id still names each of them.
    expect(
      slices('upstash_redis__get', { databaseId: 'db-def-456', key: 'k' }, [cache, twin]),
    ).toEqual(['upstash-redis.database[db-def-456].key-space[k].R']);
  });

  test('a refusal names ten mission databases at most', () => {
    const many: Resource[] = Array.from({ length: 12 }, (_, i) => ({
      service: 'upstash-redis',
      ref: `db-${i}`,
      displayName: `cache-${i}`,
    }));
    const out = classifyUpstashRedis('upstash_redis__get', { key: 'k' }, many);
    expect('denied' in out && out.denied).toMatch(
      /cache-9 \(db-9\), and 2 more — upstash_redis__list_databases lists them\.$/,
    );
    expect('denied' in out && out.denied).not.toContain('cache-10');
  });

  test('account-level tools need no database but still refuse a foreign databaseId', () => {
    expect(slices('upstash_redis__list_databases', {}, [])).toEqual([
      'upstash-redis.account.database[*].R',
    ]);
    expect(
      slices('upstash_redis__create_database', { name: 'n', region: 'r' }, [cache, queue]),
    ).toEqual(['upstash-redis.account.database.W']);
    expect(
      classifyUpstashRedis('upstash_redis__list_databases', { databaseId: 'db-other' }, [cache]),
    ).toEqual({
      denied: `upstash-redis database 'db-other' is not a resource of this mission. ${ONLY_CACHE}`,
    });
  });

  test('unknown tool is refused before any database resolution', () => {
    expect(classifyUpstashRedis('upstash_redis__flushall', {}, [])).toEqual({
      denied: "unknown upstash-redis tool 'upstash_redis__flushall'.",
    });
  });

  test('execute is routed on the command : read, write, delete, flush, unknown ; empty command is the catch-all', () => {
    const run = (command: unknown) => slices('upstash_redis__execute', { command }, [cache]);
    expect(run(['hgetall', 'h'])).toEqual(['upstash-redis.database[db-abc-123].key-space[*].R']);
    expect(run(['INCR', 'k'])).toEqual(['upstash-redis.database[db-abc-123].key-space[*].W']);
    expect(run(['DEL', 'k'])).toEqual(['upstash-redis.database[db-abc-123].key-space[*].delete.W']);
    expect(run(['flushall'])).toEqual(['upstash-redis.database[db-abc-123].key-space.flush.W']);
    expect(run(['CONFIG', 'SET', 'x', 'y'])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].execute.W',
    ]);
    expect(run([])).toEqual(['upstash-redis.database[db-abc-123].key-space[*].execute.W']);
    expect(run('GET k')).toEqual(['upstash-redis.database[db-abc-123].key-space[*].execute.W']);
  });

  test('keys that are not slice-safe (colons, braces, globs) fall back to [*] ; multi-key DEL too', () => {
    expect(slices('upstash_redis__set', { key: 'session:1', value: 'v' }, [cache])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].W',
    ]);
    expect(slices('upstash_redis__set', { key: 'user:{1}', value: 'v' }, [cache])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].W',
    ]);
    expect(slices('upstash_redis__del', { keys: ['a', 'b'] }, [cache])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].delete.W',
    ]);
    expect(slices('upstash_redis__del', { keys: ['user/1.json'] }, [cache])).toEqual([
      'upstash-redis.database[db-abc-123].key-space[user/1.json].delete.W',
    ]);
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of [
      ...slices('upstash_redis__del', { keys: ['user/1.json'] }, [cache]),
      ...slices('upstash_redis__set', { key: 'session:1', value: 'v' }, [cache]),
      ...slices('upstash_redis__execute', { command: ['FLUSHDB'] }, [cache]),
      ...slices('upstash_redis__rename_database', { name: 'x' }, [cache]),
    ]) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('environment — resolved from the owner label of the database resource', () => {
  const envOf = (tool: string, args: Record<string, unknown>, resources: readonly Resource[]) => {
    const out = classifyUpstashRedis(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return resourceEnvResolver(resources).resolveEnv(out.slices[0]!);
  };

  test('database-rooted slices resolve to the label of the database they name', () => {
    expect(
      envOf('upstash_redis__set', { databaseId: 'db-def-456', key: 'k', value: 'v' }, [
        cache,
        queue,
      ]),
    ).toBe('prod');
    expect(envOf('upstash_redis__execute', { command: ['FLUSHDB'] }, [cache])).toBe('staging');
    expect(
      envOf('upstash_redis__delete_database', { databaseId: 'db-abc-123' }, [cache, queue]),
    ).toBe('staging');
  });

  test('account-rooted slices take the single database label, null when ambiguous or unlabelled', () => {
    expect(envOf('upstash_redis__create_database', { name: 'n', region: 'r' }, [cache])).toBe(
      'staging',
    );
    expect(envOf('upstash_redis__list_databases', {}, [cache, queue])).toBeNull();
    const unlabelled: Resource = { service: 'upstash-redis', ref: 'db-x', displayName: 'x' };
    expect(envOf('upstash_redis__get', { key: 'k' }, [unlabelled])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential
// ─────────────────────────────────────────────────────────────────────────────

describe('upstash-redis credential spec', () => {
  test('api-key with a non-secret email and a secret Management API key ; no refresh', () => {
    expect(upstashRedisCredential.kind).toBe('api-key');
    const email = upstashRedisCredential.fields.find((f) => f.name === 'email')!;
    const key = upstashRedisCredential.fields.find((f) => f.name === 'api_key')!;
    expect(email.secret).toBe(false);
    expect(key.secret).toBe(true);
    expect(new RegExp(email.pattern!).test('ops@acme.com')).toBe(true);
    expect(new RegExp(email.pattern!).test('not an email')).toBe(false);
    expect('refresh' in upstashRedisPlugin).toBe(false);
  });

  test('upstashAuth narrows the secret and refuses the wrong kind or a missing field', () => {
    expect(upstashAuth(credential)).toEqual({ email: 'ops@acme.com', apiKey: 'upstash_key_123' });
    expect(basicAuthHeader(upstashAuth(credential))).toBe(EXPECTED_BASIC);
    expect(() =>
      upstashAuth({
        kind: 'oauth2',
        accessToken: 'x',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        metadata: {},
      }),
    ).toThrow(CredentialKindMismatch);
    expect(() =>
      upstashAuth({ kind: 'api-key', fields: { email: 'ops@acme.com' }, metadata: {} }),
    ).toThrow(/api_key/);
    expect(() => upstashAuth({ kind: 'api-key', fields: { api_key: 'k' }, metadata: {} })).toThrow(
      /email/,
    );
    expect(() =>
      upstashAuth({ kind: 'api-key', fields: { email: 'nope', api_key: 'k' }, metadata: {} }),
    ).toThrow(/email/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute
// ─────────────────────────────────────────────────────────────────────────────

describe('executeUpstashRedis with mockFetch', () => {
  test("management tool : Basic auth, GET /redis/databases, the mission's databases alone, REST tokens redacted", async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${UPSTASH_MANAGEMENT_API}/redis/databases`,
        body: [
          {
            database_id: 'db-abc-123',
            database_name: 'app-cache',
            rest_token: 'secret',
            password: 'pw',
          },
          { database_id: 'db-outside', database_name: 'billing-prod', rest_token: 'other' },
          { database_name: 'no-id' },
        ],
      },
    ]);
    const result = await upstashRedisPlugin.execute(
      ctx(fetch),
      'upstash_redis__list_databases',
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(fetch.calls[0]!.headers.authorization).toBe(EXPECTED_BASIC);
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({
      databases: [{ database_id: 'db-abc-123', database_name: 'app-cache' }],
      note: LIST_DATABASES_NOTE,
    });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('db-outside');
    expect(text).not.toContain('billing-prod');
  });

  test('list_databases : an answer that is not a list is an upstream protocol failure', async () => {
    const fetch = mockFetch([{ url: /\/redis\/databases$/, body: { databases: [] } }]);
    await expect(
      upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__list_databases', {}),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('data tool : reads the REST endpoint and token from the Management API, then POSTs the command with the Bearer', async () => {
    const fetch = mockFetch([
      databaseRoute,
      { method: 'POST', url: REST_URL, body: { result: 'hello' } },
    ]);
    const result = await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', {
      key: 'mykey',
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ result: 'hello' });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]!.url).toBe(DATABASE_URL);
    expect(fetch.calls[1]!.headers.authorization).toBe('Bearer AXxxRestToken');
    expect(fetch.calls[1]!.json).toEqual(['GET', 'mykey']);
  });

  test('set builds the SET command with TTL and conditional flags', async () => {
    const fetch = mockFetch([
      databaseRoute,
      { method: 'POST', url: REST_URL, body: { result: 'OK' } },
    ]);
    await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__set', {
      databaseId: 'db-abc-123',
      key: 'session:1',
      value: 'data',
      ex: 3600,
      nx: true,
    });
    expect(fetch.calls[1]!.json).toEqual(['SET', 'session:1', 'data', 'EX', '3600', 'NX']);
  });

  test('refuses a database the mission does not hold, and an ambiguous mission, before any network call', async () => {
    const fetch = mockFetch([]);
    const foreignDb = await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', {
      databaseId: 'db-other',
      key: 'k',
    });
    expect(foreignDb.isError).toBe(true);
    expect((foreignDb.content[0] as { text: string }).text).toMatch(/db-other/);

    const ambiguous = await upstashRedisPlugin.execute(
      ctx(fetch, [cache, queue]),
      'upstash_redis__get',
      {
        key: 'k',
      },
    );
    expect(ambiguous.isError).toBe(true);
    expect((ambiguous.content[0] as { text: string }).text).toMatch(/2 Upstash databases/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a database named by its name : execute sends its id, the one the slice names', async () => {
    const fetch = mockFetch([
      databaseRoute,
      { method: 'POST', url: REST_URL, body: { result: 'v' } },
    ]);
    const args = { databaseId: 'app-cache', key: 'k' };
    expect(classifyUpstashRedis('upstash_redis__get', args, [cache, queue])).toMatchObject({
      slices: [expect.anything()],
    });
    const result = await upstashRedisPlugin.execute(
      ctx(fetch, [cache, queue]),
      'upstash_redis__get',
      args,
    );
    expect(result.isError).toBeUndefined();
    expect(fetch.calls.map((c) => c.url)).toEqual([DATABASE_URL, REST_URL]);
    expect(fetch.calls[1]!.json).toEqual(['GET', 'k']);

    const stats = mockFetch([
      { method: 'GET', url: `${UPSTASH_MANAGEMENT_API}/redis/stats/db-def-456`, body: {} },
    ]);
    await upstashRedisPlugin.execute(
      ctx(stats, [cache, queue]),
      'upstash_redis__get_database_stats',
      {
        databaseId: 'app-queue',
      },
    );
    expect(stats.calls.map((c) => c.url)).toEqual([
      `${UPSTASH_MANAGEMENT_API}/redis/stats/db-def-456`,
    ]);
  });

  test('401 / 403 become UpstreamAuthError on both surfaces', async () => {
    const mgmt = mockFetch([{ url: /\/redis\/databases$/, status: 401, body: 'Unauthorized' }]);
    await expect(
      upstashRedisPlugin.execute(ctx(mgmt), 'upstash_redis__list_databases', {}),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });

    const data = mockFetch([
      databaseRoute,
      { method: 'POST', url: REST_URL, status: 403, body: {} },
    ]);
    await expect(
      upstashRedisPlugin.execute(ctx(data), 'upstash_redis__get', { key: 'k' }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 403 });
  });

  test('a service failure is thrown with its status, on both surfaces (never an isError result)', async () => {
    const http = mockFetch([{ url: /\/redis\/stats\//, status: 500, body: 'boom' }]);
    await expect(
      upstashRedisPlugin.execute(ctx(http), 'upstash_redis__get_database_stats', {
        databaseId: 'db-abc-123',
      }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });

    const data = mockFetch([
      databaseRoute,
      { method: 'POST', url: REST_URL, status: 429, body: 'slow down' },
    ]);
    await expect(
      upstashRedisPlugin.execute(ctx(data), 'upstash_redis__get', { key: 'k' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 429 });
  });

  test('a network failure is thrown as it is, not turned into a result', async () => {
    const down = mockFetch([
      {
        url: /\/redis\/databases$/,
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    await expect(
      upstashRedisPlugin.execute(ctx(down), 'upstash_redis__list_databases', {}),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test('malformed arguments come back as isError results, before any network call', async () => {
    const none = mockFetch([]);
    const r2 = await upstashRedisPlugin.execute(ctx(none), 'upstash_redis__del', { keys: [] });
    expect(r2.isError).toBe(true);
    expect((r2.content[0] as { text: string }).text).toMatch(/keys/);
    expect(none.calls).toHaveLength(0);
  });

  test('redactDatabases strips the credential fields from objects and lists', () => {
    expect(
      redactDatabases({ a: 1, rest_token: 't', read_only_rest_token: 'r', password: 'p' }),
    ).toEqual({ a: 1 });
    expect(redactDatabases([{ rest_token: 't' }, 'OK'])).toEqual([{}, 'OK']);
    expect(redactDatabases('OK')).toBe('OK');
    // A credential-like field Upstash may add later is stripped by its name.
    expect(redactDatabases({ a: 1, admin_token: 'x', backup_secret: 'y', api_key: 'z' })).toEqual({
      a: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverResources
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverUpstashRedisResources with mockFetch', () => {
  test('one resource per database, metadata without any token, env left to the owner', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${UPSTASH_MANAGEMENT_API}/redis/databases`,
        body: [
          {
            database_id: 'db-abc-123',
            database_name: 'app-cache',
            database_type: 'Pay as You Go',
            region: 'eu-west-1',
            endpoint: 'eu1-app-cache.upstash.io',
            state: 'active',
            tls: true,
            rest_token: 'secret',
          },
          {
            database_id: 'db-def-456',
            database_name: 'app-queue',
            region: 'global',
            primary_region: 'us-east-1',
            read_regions: ['eu-west-1'],
          },
          { database_name: 'no-id' },
        ],
      },
    ]);
    const resources = await upstashRedisPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual(['db-abc-123', 'db-def-456']);
    expect(resources[0]).toEqual({
      service: 'upstash-redis',
      ref: 'db-abc-123',
      displayName: 'app-cache',
      metadata: {
        region: 'eu-west-1',
        endpoint: 'eu1-app-cache.upstash.io',
        state: 'active',
        database_type: 'Pay as You Go',
        tls: true,
      },
    });
    expect(resources[1]!.metadata).toEqual({
      region: 'global',
      primary_region: 'us-east-1',
      read_regions: ['eu-west-1'],
    });
    expect(JSON.stringify(resources)).not.toContain('secret');
    expect(resources.every((r) => r.env === undefined)).toBe(true);
    expect(fetch.calls[0]!.headers.authorization).toBe(EXPECTED_BASIC);
  });

  test('caps the list at MAX_DISCOVERED_DATABASES and warns through the logger', async () => {
    const many = Array.from({ length: MAX_DISCOVERED_DATABASES + 1 }, (_, i) => ({
      database_id: `db-${i}`,
      database_name: `db ${i}`,
    }));
    const fetch = mockFetch([{ method: 'GET', url: /\/redis\/databases$/, body: many }]);
    const warn = vi.fn();
    const logger: PluginLogger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const resources = await upstashRedisPlugin.discoverResources(ctx(fetch, [], logger));
    expect(resources).toHaveLength(MAX_DISCOVERED_DATABASES);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/truncated/), {
      total: MAX_DISCOVERED_DATABASES + 1,
      cap: MAX_DISCOVERED_DATABASES,
    });
  });

  test('an answer that is not a list is an upstream protocol failure, not an empty account', async () => {
    const fetch = mockFetch([{ url: /\/redis\/databases$/, body: { databases: [] } }]);
    const attempt = upstashRedisPlugin.discoverResources(ctx(fetch));
    await expect(attempt).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(attempt).rejects.toThrow(
      'Upstash Management API GET /redis/databases: unexpected answer',
    );
  });

  test('a metadata value of another type than Upstash documents is left out', async () => {
    const fetch = mockFetch([
      {
        url: /\/redis\/databases$/,
        body: [{ database_id: 'db-1', database_name: 7, region: { r: 1 }, state: 'active' }],
      },
    ]);
    expect(await upstashRedisPlugin.discoverResources(ctx(fetch))).toEqual([
      {
        service: 'upstash-redis',
        ref: 'db-1',
        displayName: 'db-1',
        metadata: { state: 'active' },
      },
    ]);
  });

  test('a rejected key surfaces as UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { url: /\/redis\/databases$/, status: 403, body: { error: 'forbidden' } },
    ]);
    await expect(upstashRedisPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
  });
});
