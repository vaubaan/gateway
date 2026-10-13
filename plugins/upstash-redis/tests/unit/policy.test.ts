/**
 * The shipped catalog and presets, through the real engine.
 *
 * Each call goes the way the gateway takes it : the plugin classifies, then
 * `evaluateCall` intersects the slices with the loaded catalog, qualifies
 * the touched risks with the environment label of the database
 * (`envResolverFor(resources, plugin.envOf)`, the resolver the gateway
 * builds) and checks them against the accepted risks of a mission issued
 * from a preset.
 *
 * Two rules are pinned here :
 *   - an env-scoped risk touched on a database with no label, or with a
 *     label outside `acceptable_in_envs`, refuses the call — every Upstash
 *     write risk is env-scoped, so no write passes on such a database ;
 *   - a preset allows and refuses what its description says, whichever tool
 *     carries the command (`DEL` through the generic `execute` tool needs
 *     `delete-data`, like the dedicated `del` tool).
 */
import { describe, expect, test } from 'vitest';

import type { ProviderPlugin, Resource } from '@vaubaan/plugin-sdk';
import { envResolverFor, evaluateCall, indexCatalog } from '@vaubaan/policy-engine';

import { upstashRedisPlugin } from '../../src/index.ts';

/** Typed as the contract, so the optional `envOf` hook is read the way the gateway reads it. */
const plugin: ProviderPlugin = upstashRedisPlugin;

const indexed = indexCatalog(plugin.catalog);

type RiskDecision = ReturnType<typeof evaluateCall>;

function database(env?: string): Resource {
  return {
    provider: 'upstash-redis',
    ref: `db-${env ?? 'unlabelled'}`,
    displayName: env ?? 'unlabelled',
    ...(env !== undefined ? { env } : {}),
  };
}

/** The accepted risks a mission gets from a preset, exactly as the preset lists them. */
function acceptedBy(presetId: string): ReadonlySet<string> {
  const preset = upstashRedisPlugin.catalog.presets.find((p) => p.id === presetId);
  if (!preset) throw new Error(`no preset '${presetId}'`);
  return new Set(preset.entries.map((e) => e.risk_id));
}

/** Classify, then decide — the two steps of `evaluateCallForToken`. */
function decide(
  accepted: ReadonlySet<string>,
  resource: Resource,
  tool: string,
  args: Record<string, unknown>,
): RiskDecision {
  const resources = [resource];
  const outcome = plugin.classify(tool, args, resources);
  if ('denied' in outcome) throw new Error(`classifier denied: ${outcome.denied}`);
  return evaluateCall({
    executed_slices: outcome.slices,
    token_accepted_risks: accepted,
    catalog: indexed,
    envResolver: envResolverFor(resources, plugin.envOf?.bind(plugin)),
  });
}

function missing(decision: RiskDecision): readonly string[] {
  if (decision.outcome !== 'denied') throw new Error('expected a refusal, the call was allowed');
  return decision.missing_risks;
}

const execute = (command: unknown) =>
  ['upstash_redis__execute', { command }] as [string, Record<string, unknown>];

/** Every risk of the catalog in every environment it can be qualified with, the fallback included. */
const everything: ReadonlySet<string> = new Set(
  upstashRedisPlugin.catalog.risks.flatMap((r) => {
    const suffix = r.id.slice('upstash-redis'.length);
    return [r.id, ...(r.acceptable_in_envs ?? []).map((env) => `upstash-redis[${env}]${suffix}`)];
  }),
);

describe('a database with no environment label, or a label the catalog does not list', () => {
  const writes: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['upstash_redis__set', { key: 'k', value: 'v' }, 'upstash-redis.write-data'],
    ['upstash_redis__hset', { key: 'h', fields: { f: 'v' } }, 'upstash-redis.write-data'],
    ['upstash_redis__expire', { key: 'k', seconds: 60 }, 'upstash-redis.write-data'],
    ['upstash_redis__del', { keys: ['k'] }, 'upstash-redis.delete-data'],
    [...execute(['SET', 'k', 'v']), 'upstash-redis.write-data'],
    [...execute(['DEL', 'k']), 'upstash-redis.delete-data'],
    [...execute(['FLUSHDB']), 'upstash-redis.flush-database'],
    [...execute(['EVAL', 'return 1', '0']), 'upstash-redis.execute-arbitrary'],
    ['upstash_redis__delete_database', {}, 'upstash-redis.delete-database'],
    ['upstash_redis__rename_database', { name: 'n' }, 'upstash-redis.modify-database'],
  ];

  for (const [tool, args, bareRisk] of writes) {
    test(`${tool} ${JSON.stringify(args)} is refused on an unlabelled database, whatever the mission accepts`, () => {
      const decision = decide(everything, database(), tool, args);
      expect(decision.outcome).toBe('denied');
      // The unqualified id is what the call touches there ; no mission can hold it.
      expect(missing(decision)).toContain(bareRisk);
      expect(decision.outcome === 'denied' && decision.hint).toMatch(/no environment label/);
    });
  }

  test('a write is refused on a database labelled outside the catalog environments', () => {
    const decision = decide(everything, database('dev'), 'upstash_redis__set', {
      key: 'k',
      value: 'v',
    });
    expect(missing(decision)).toEqual(['upstash-redis[dev].write-data']);
    expect(decision.outcome === 'denied' && decision.hint).toMatch(
      /labelled 'dev'.*\[development, staging, prod\]/,
    );
  });

  test('reads are account-scoped : they pass on an unlabelled database', () => {
    const readOnly = acceptedBy('read-only');
    expect(decide(readOnly, database(), 'upstash_redis__get', { key: 'k' }).outcome).toBe(
      'allowed',
    );
    expect(decide(readOnly, database(), ...execute(['HGETALL', 'h'])).outcome).toBe('allowed');
    expect(decide(readOnly, database(), 'upstash_redis__get_database_stats', {}).outcome).toBe(
      'allowed',
    );
  });
});

describe('preset read-only — inspect, no write', () => {
  const accepted = acceptedBy('read-only');

  test('allows the reads, through the dedicated tools and through execute', () => {
    for (const env of ['development', 'staging', 'prod']) {
      const db = database(env);
      expect(decide(accepted, db, 'upstash_redis__get', { key: 'k' }).outcome).toBe('allowed');
      expect(decide(accepted, db, 'upstash_redis__keys', { pattern: '*' }).outcome).toBe('allowed');
      expect(decide(accepted, db, 'upstash_redis__get_database', {}).outcome).toBe('allowed');
      expect(decide(accepted, db, 'upstash_redis__list_databases', {}).outcome).toBe('allowed');
      expect(decide(accepted, db, ...execute(['GET', 'k'])).outcome).toBe('allowed');
      expect(
        decide(
          accepted,
          db,
          ...execute([
            ['GET', 'a'],
            ['TTL', 'a'],
          ]),
        ).outcome,
      ).toBe('allowed');
    }
  });

  test('refuses every write, in every environment', () => {
    const db = database('development');
    expect(missing(decide(accepted, db, 'upstash_redis__set', { key: 'k', value: 'v' }))).toEqual([
      'upstash-redis[development].write-data',
    ]);
    expect(missing(decide(accepted, db, ...execute(['DEL', 'k'])))).toEqual([
      'upstash-redis[development].write-data',
      'upstash-redis[development].delete-data',
    ]);
    expect(missing(decide(accepted, db, ...execute(['FLUSHALL'])))).toContain(
      'upstash-redis[development].flush-database',
    );
    expect(missing(decide(accepted, db, ...execute(['EVAL', 'return 1', '0'])))).toContain(
      'upstash-redis[development].execute-arbitrary',
    );
    expect(
      missing(decide(accepted, db, 'upstash_redis__create_database', { name: 'n', region: 'r' })),
    ).toEqual(['upstash-redis.create-database']);
    // A read hidden in a pipeline does not carry the write next to it.
    expect(
      missing(
        decide(
          accepted,
          db,
          ...execute([
            ['GET', 'a'],
            ['SET', 'a', 'v'],
          ]),
        ),
      ),
    ).toEqual(['upstash-redis[development].write-data']);
  });
});

describe('preset developer — key-level writes and targeted DEL on development and staging', () => {
  const accepted = acceptedBy('developer');

  for (const env of ['development', 'staging']) {
    test(`on ${env} : key writes and DEL are allowed, by either tool`, () => {
      const db = database(env);
      expect(decide(accepted, db, 'upstash_redis__set', { key: 'k', value: 'v' }).outcome).toBe(
        'allowed',
      );
      expect(decide(accepted, db, 'upstash_redis__expire', { key: 'k', seconds: 60 }).outcome).toBe(
        'allowed',
      );
      expect(decide(accepted, db, 'upstash_redis__del', { keys: ['a', 'b'] }).outcome).toBe(
        'allowed',
      );
      expect(decide(accepted, db, ...execute(['INCR', 'counter'])).outcome).toBe('allowed');
      expect(decide(accepted, db, ...execute(['DEL', 'a', 'b'])).outcome).toBe('allowed');
      expect(decide(accepted, db, ...execute(['EXPIRE', 'k', '0'])).outcome).toBe('allowed');
    });

    test(`on ${env} : no FLUSH, no arbitrary command, no database management`, () => {
      const db = database(env);
      expect(missing(decide(accepted, db, ...execute(['FLUSHDB'])))).toEqual([
        `upstash-redis[${env}].flush-database`,
      ]);
      for (const command of [
        ['EVAL', "return redis.call('FLUSHALL')", '0'],
        ['CONFIG', 'SET', 'maxmemory', '0'],
        ['FROBNICATE'],
        [],
      ]) {
        expect(missing(decide(accepted, db, ...execute(command)))).toEqual([
          `upstash-redis[${env}].execute-arbitrary`,
        ]);
      }
      expect(missing(decide(accepted, db, 'upstash_redis__delete_database', {}))).toEqual([
        `upstash-redis[${env}].delete-database`,
      ]);
      expect(
        missing(decide(accepted, db, 'upstash_redis__rename_database', { name: 'n' })),
      ).toEqual([`upstash-redis[${env}].modify-database`]);
      // One forbidden command refuses the whole pipeline.
      expect(
        missing(decide(accepted, db, ...execute([['SET', 'k', 'v'], ['DEL', 'j'], ['FLUSHDB']]))),
      ).toEqual([`upstash-redis[${env}].flush-database`]);
    });
  }

  test('nothing is written on prod : reads only', () => {
    const db = database('prod');
    expect(decide(accepted, db, 'upstash_redis__get', { key: 'k' }).outcome).toBe('allowed');
    expect(missing(decide(accepted, db, 'upstash_redis__set', { key: 'k', value: 'v' }))).toEqual([
      'upstash-redis[prod].write-data',
    ]);
    expect(missing(decide(accepted, db, 'upstash_redis__del', { keys: ['k'] }))).toEqual([
      'upstash-redis[prod].write-data',
      'upstash-redis[prod].delete-data',
    ]);
    expect(missing(decide(accepted, db, ...execute(['DEL', 'k'])))).toEqual([
      'upstash-redis[prod].write-data',
      'upstash-redis[prod].delete-data',
    ]);
  });
});

describe('preset operator — everything, each command under the risk that names it', () => {
  const accepted = acceptedBy('operator');

  test('allows every class of command in every environment', () => {
    for (const env of ['development', 'staging', 'prod']) {
      const db = database(env);
      for (const command of [
        ['GET', 'k'],
        ['SET', 'k', 'v'],
        ['DEL', 'k'],
        ['FLUSHDB'],
        ['EVAL', 'return 1', '0'],
        [['MULTI'], ['SET', 'k', 'v'], ['DEL', 'j'], ['EXEC']],
      ]) {
        expect(
          decide(accepted, db, ...execute(command)).outcome,
          `${env} ${JSON.stringify(command)}`,
        ).toBe('allowed');
      }
      expect(decide(accepted, db, 'upstash_redis__delete_database', {}).outcome).toBe('allowed');
      expect(decide(accepted, db, 'upstash_redis__rename_database', { name: 'n' }).outcome).toBe(
        'allowed',
      );
    }
  });

  test('never the fallback : an operator mission holds no uncategorized write', () => {
    expect([...accepted].some((id) => id.includes('uncategorized'))).toBe(false);
  });

  // M5 : `[prod].write-data` is `auto`, `[prod].delete-data` is behind
  // approval. A DEL must touch the gated risk whichever tool carries it,
  // or the approval is skipped by choosing the other tool.
  test('a prod DEL touches the approval-gated delete-data, through del and through execute', () => {
    const gateOf = (riskId: string) =>
      upstashRedisPlugin.catalog.presets
        .find((p) => p.id === 'operator')!
        .entries.find((e) => e.risk_id === riskId)!.gate;
    expect(gateOf('upstash-redis[prod].write-data')).toBe('auto');
    expect(gateOf('upstash-redis[prod].delete-data')).toBe('approval');

    const prod = database('prod');
    const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['upstash_redis__del', { keys: ['a', 'b', 'c'] }],
      execute(['DEL', 'a', 'b', 'c']),
      execute(['unlink', 'a']),
      execute(['GETDEL', 'a']),
      execute(['EXPIRE', 'a', '0']),
      ['upstash_redis__expire', { key: 'a', seconds: 0 }],
      execute([
        ['GET', 'a'],
        ['DEL', 'a'],
      ]),
    ];
    for (const [tool, args] of calls) {
      const decision = decide(accepted, prod, tool, args);
      expect(decision.outcome, `${tool} ${JSON.stringify(args)}`).toBe('allowed');
      expect(
        decision.outcome === 'allowed' && decision.risks_touched,
        `${tool} ${JSON.stringify(args)}`,
      ).toContain('upstash-redis[prod].delete-data');
    }
  });

  test('with write-data alone on prod, a DEL is refused by either tool', () => {
    const writeOnly = new Set([
      'upstash-redis.read-database-metadata',
      'upstash-redis.read-data',
      'upstash-redis[prod].write-data',
    ]);
    const prod = database('prod');
    expect(decide(writeOnly, prod, ...execute(['SET', 'k', 'v'])).outcome).toBe('allowed');
    for (const [tool, args] of [
      ['upstash_redis__del', { keys: ['a', 'b', 'c'] }],
      execute(['DEL', 'a', 'b', 'c']),
      execute(['UNLINK', 'a']),
      execute(['GETDEL', 'a']),
      execute(['EXPIRE', 'a', '0']),
      ['upstash_redis__expire', { key: 'a', seconds: 0 }],
    ] as ReadonlyArray<[string, Record<string, unknown>]>) {
      expect(
        missing(decide(writeOnly, prod, tool, args)),
        `${tool} ${JSON.stringify(args)}`,
      ).toEqual(['upstash-redis[prod].delete-data']);
    }
  });

  test('arbitrary execution outside development is behind approval, like the FLUSH a script can run', () => {
    const operator = upstashRedisPlugin.catalog.presets.find((p) => p.id === 'operator')!;
    const gateOf = (riskId: string) => operator.entries.find((e) => e.risk_id === riskId)!.gate;
    for (const env of ['staging', 'prod']) {
      expect(gateOf(`upstash-redis[${env}].flush-database`)).toBe('approval');
      expect(gateOf(`upstash-redis[${env}].execute-arbitrary`)).toBe('approval');
    }
  });
});
