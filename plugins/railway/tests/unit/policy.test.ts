/**
 * Tests — Railway calls decided end to end : the real classifier, the real
 * catalog and the gateway decision core (`evaluateCallForToken`), with the
 * accepted risks of each shipped preset.
 *
 * Spec     : docs/spec/gateway-risk-model.md §8 (strict-fail runtime) ;
 *            docs/spec/vaubaan-gateway.md §3.2 (presets), §10.
 * Handbook : docs/handbook/providers/railway.md.
 *
 * What the slice-shape tests (`classify.test.ts`) cannot show :
 *   - a single-variable write touches `upsert-variable` alone, so the
 *     `developer` preset can actually write variables ; only the "replace
 *     all variables" case touches `bulk-variables-replace` ;
 *   - an env-scoped risk touched on a project whose label is absent or
 *     outside `acceptable_in_envs` refuses the call — it is never dropped ;
 *   - `environmentId` must belong to the project the call is classified on.
 */
import { describe, expect, test } from 'vitest';

import { evaluateCallForToken, type CallVerdict } from '@vaubaan/gateway-core';
import { PluginRegistry, type Resource } from '@vaubaan/plugin-sdk';

import { railwayPlugin } from '../../src/index.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002';
const SERVICE = '00000000-0000-4000-8000-00000000000a';
const ENV_ID = '00000000-0000-4000-8000-0000000000e1';
const OTHER_ENV_ID = '00000000-0000-4000-8000-0000000000e2';

/** The Railway project of the mission, labelled by its owner (or not). */
function project(env?: string): Resource {
  return {
    provider: 'railway',
    ref: PROJECT,
    displayName: 'api',
    ...(env === undefined ? {} : { env }),
    metadata: { environments: [{ id: ENV_ID, name: 'main' }] },
  };
}

const catalog = new PluginRegistry([railwayPlugin]).catalogOf(railwayPlugin.id);

function presetRisks(id: string): readonly string[] {
  const preset = (railwayPlugin.catalog.presets ?? []).find((p) => p.id === id);
  if (!preset) throw new Error(`no preset '${id}' in the railway catalog`);
  return preset.entries.map((e) => e.risk_id);
}

function decide(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[],
  accepted: readonly string[],
): CallVerdict {
  return evaluateCallForToken({
    tool,
    args,
    resources,
    token: { id: 'mission-under-test', accepted_risks: accepted, denied_risks: [] },
    adapter: railwayPlugin,
    catalog,
  });
}

/** `allow`, or `deny` followed by the sorted missing risks, or the classifier's refusal. */
function outcome(verdict: CallVerdict): string {
  if (verdict.kind === 'allow') return 'allow';
  if (verdict.kind === 'deny') return `deny: ${[...verdict.missing_risks].sort().join(', ')}`;
  if (verdict.kind === 'classify-denied') return `classify-denied: ${verdict.reason}`;
  return verdict.kind;
}

const target = { projectId: PROJECT, environmentId: ENV_ID };

const CALLS = {
  whoami: ['railway__whoami', {}],
  listServices: ['railway__list-services', { projectId: PROJECT }],
  getLogs: ['railway__get-logs', { ...target, serviceId: SERVICE }],
  listVariables: ['railway__list-variables', target],
  redeploy: ['railway__redeploy', { ...target, serviceId: SERVICE }],
  acceptDeploy: ['railway__accept-deploy', { environmentId: ENV_ID }],
  upsertVariable: ['railway__upsert-variable', { ...target, name: 'API_KEY', value: 'x' }],
  deleteVariable: ['railway__delete-variable', { ...target, name: 'API_KEY' }],
  upsertVariables: ['railway__upsert-variables', { ...target, variables: { A: '1', B: '2' } }],
  replaceVariables: [
    'railway__upsert-variables',
    { ...target, variables: { A: '1' }, replace: true },
  ],
  createProject: ['railway__create-project', { name: 'new' }],
  agent: ['railway__railway-agent', { ...target, message: 'scale the worker' }],
} as const satisfies Record<string, readonly [string, Record<string, unknown>]>;

type CallName = keyof typeof CALLS;
const CALL_NAMES = Object.keys(CALLS) as CallName[];

function run(call: CallName, env: string | undefined, accepted: readonly string[]): string {
  const [tool, args] = CALLS[call];
  return outcome(decide(tool, args, [project(env)], accepted));
}

/** The decision of every sample call for one accepted set, on a project labelled `env`. */
function runAll(env: string | undefined, accepted: readonly string[]): Record<string, string> {
  return Object.fromEntries(CALL_NAMES.map((call) => [call, run(call, env, accepted)]));
}

// ─── Variable writes : one variable is not "replace them all" ───────────────

describe('railway variable writes — risks touched', () => {
  const everyVariableRisk = ['railway[staging].upsert-variable', 'railway.bulk-variables-replace'];

  function touched(call: CallName): readonly string[] {
    const [tool, args] = CALLS[call];
    const verdict = decide(tool, args, [project('staging')], everyVariableRisk);
    if (verdict.kind !== 'allow') throw new Error(`expected allow, got ${outcome(verdict)}`);
    return verdict.risks_touched;
  }

  test('upsert-variable touches upsert-variable alone', () => {
    expect(touched('upsertVariable')).toEqual(['railway[staging].upsert-variable']);
  });

  test('delete-variable touches upsert-variable alone', () => {
    expect(touched('deleteVariable')).toEqual(['railway[staging].upsert-variable']);
  });

  test('upsert-variables without replace touches upsert-variable alone', () => {
    expect(touched('upsertVariables')).toEqual(['railway[staging].upsert-variable']);
  });

  test('upsert-variables with replace: true also touches bulk-variables-replace', () => {
    expect(touched('replaceVariables')).toEqual(everyVariableRisk);
  });

  test.each([
    ['an empty payload', { variables: {} }],
    ['a payload that is not an object', { variables: 'A=1' }],
    ['a missing payload', {}],
    ['a replace flag that is not a boolean', { variables: { A: '1' }, replace: 'true' }],
  ])('upsert-variables with %s is treated as a replace', (_label, extra) => {
    const verdict = decide(
      'railway__upsert-variables',
      { ...target, ...extra },
      [project('staging')],
      ['railway[staging].upsert-variable'],
    );
    expect(outcome(verdict)).toBe('deny: railway.bulk-variables-replace');
  });

  test('a single-variable write without a name is refused by the classifier', () => {
    for (const tool of ['railway__upsert-variable', 'railway__delete-variable']) {
      for (const name of [undefined, '']) {
        const verdict = decide(tool, { ...target, name }, [project('staging')], everyVariableRisk);
        expect(outcome(verdict)).toBe('classify-denied: name: required.');
      }
    }
  });
});

// ─── Each shipped preset, call by call ───────────────────────────────────────

describe('railway presets — decision per call', () => {
  test('read-only : reads of account, runtime and logs ; nothing else', () => {
    expect(runAll('staging', presetRisks('read-only'))).toEqual({
      whoami: 'allow',
      listServices: 'allow',
      getLogs: 'allow',
      listVariables: 'deny: railway[staging].read-variables',
      redeploy: 'deny: railway[staging].deploy',
      acceptDeploy: 'deny: railway[staging].deploy',
      upsertVariable: 'deny: railway[staging].upsert-variable',
      deleteVariable: 'deny: railway[staging].upsert-variable',
      upsertVariables: 'deny: railway[staging].upsert-variable',
      replaceVariables: 'deny: railway.bulk-variables-replace, railway[staging].upsert-variable',
      createProject: 'deny: railway.create-project',
      agent:
        'deny: railway.agent-action, railway.bulk-variables-replace, ' +
        'railway[staging].deploy, railway[staging].upsert-variable',
    });
  });

  test.each(['dev', 'preview', 'staging'])(
    'developer on a %s project : deploys and single-variable writes, no destructive replace',
    (env) => {
      expect(runAll(env, presetRisks('developer'))).toEqual({
        whoami: 'allow',
        listServices: 'allow',
        getLogs: 'allow',
        listVariables: 'allow',
        redeploy: 'allow',
        acceptDeploy: 'allow',
        upsertVariable: 'allow',
        deleteVariable: 'allow',
        upsertVariables: 'allow',
        replaceVariables: 'deny: railway.bulk-variables-replace',
        createProject: 'deny: railway.create-project',
        agent: 'deny: railway.agent-action, railway.bulk-variables-replace',
      });
    },
  );

  test('developer on a prod project : no variable values ; writes pass the risk step', () => {
    // The `approval` gate of the prod entries is applied after this step, by the gateway.
    expect(runAll('prod', presetRisks('developer'))).toEqual({
      whoami: 'allow',
      listServices: 'allow',
      getLogs: 'allow',
      listVariables: 'deny: railway[prod].read-variables',
      redeploy: 'allow',
      acceptDeploy: 'allow',
      upsertVariable: 'allow',
      deleteVariable: 'allow',
      upsertVariables: 'allow',
      replaceVariables: 'deny: railway.bulk-variables-replace',
      createProject: 'deny: railway.create-project',
      agent: 'deny: railway.agent-action, railway.bulk-variables-replace',
    });
  });

  test.each(['dev', 'preview', 'staging', 'prod'])(
    'operator on a %s project : everything but the agent meta-tool',
    (env) => {
      expect(runAll(env, presetRisks('operator'))).toEqual({
        whoami: 'allow',
        listServices: 'allow',
        getLogs: 'allow',
        listVariables: 'allow',
        redeploy: 'allow',
        acceptDeploy: 'allow',
        upsertVariable: 'allow',
        deleteVariable: 'allow',
        upsertVariables: 'allow',
        replaceVariables: 'allow',
        createProject: 'allow',
        agent: 'deny: railway.agent-action',
      });
    },
  );

  test('railway-agent needs agent-action on top of every write risk it could take', () => {
    const accepted = [...presetRisks('operator'), 'railway.agent-action'];
    expect(run('agent', 'staging', accepted)).toBe('allow');
    expect(run('agent', 'staging', [...presetRisks('developer'), 'railway.agent-action'])).toBe(
      'deny: railway.bulk-variables-replace',
    );
  });

  test('no preset grants the agent meta-tool or the fallback', () => {
    for (const preset of railwayPlugin.catalog.presets ?? []) {
      const ids = preset.entries.map((e) => e.risk_id);
      expect(ids).not.toContain('railway.agent-action');
      expect(ids).not.toContain('railway.uncategorized-write');
    }
  });
});

// ─── Env-scoped risks outside their environments refuse the call ────────────

describe('railway env-scoped risks — a label is required', () => {
  /** Every id a mission could hold : the catalog ids and their qualified forms. */
  const everything = [...railwayPlugin.catalog.risks.map((r) => r.id), ...presetRisks('operator')];

  test('list-variables with the read-only preset is refused on a prod project', () => {
    const verdict = decide(...CALLS.listVariables, [project('prod')], presetRisks('read-only'));
    expect(outcome(verdict)).toBe('deny: railway[prod].read-variables');
  });

  test('list-variables with the read-only preset is refused on an unlabelled project', () => {
    const verdict = decide(...CALLS.listVariables, [project()], presetRisks('read-only'));
    expect(outcome(verdict)).toBe('deny: railway.read-variables');
    if (verdict.kind !== 'deny') throw new Error('unreachable');
    expect(verdict.hint).toContain('no environment label');
    // `read-runtime` alone used to carry this call : it is covered, and not enough.
    expect(verdict.risks_touched).toContain('railway.read-runtime');
  });

  test('list-variables with the read-only preset is refused on a project labelled `production`', () => {
    const verdict = decide(
      ...CALLS.listVariables,
      [project('production')],
      presetRisks('read-only'),
    );
    expect(outcome(verdict)).toBe('deny: railway[production].read-variables');
    if (verdict.kind !== 'deny') throw new Error('unreachable');
    expect(verdict.hint).toContain("labelled 'production'");
  });

  test('no accepted risk opens an env-scoped operation on an unlabelled project', () => {
    expect(run('listVariables', undefined, everything)).toBe('deny: railway.read-variables');
    expect(run('redeploy', undefined, everything)).toBe('deny: railway.deploy');
    expect(run('acceptDeploy', undefined, everything)).toBe('deny: railway.deploy');
    expect(run('upsertVariable', undefined, everything)).toBe('deny: railway.upsert-variable');
    expect(run('deleteVariable', undefined, everything)).toBe('deny: railway.upsert-variable');
    expect(run('upsertVariables', undefined, everything)).toBe('deny: railway.upsert-variable');
    expect(run('replaceVariables', undefined, everything)).toBe('deny: railway.upsert-variable');
  });

  test('railway-agent is refused on an unlabelled project, whatever the mission accepts', () => {
    expect(run('agent', undefined, everything)).toBe(
      'deny: railway.deploy, railway.upsert-variable',
    );
    expect(run('agent', undefined, presetRisks('operator'))).toBe(
      'deny: railway.agent-action, railway.deploy, railway.upsert-variable',
    );
  });

  test('operations that touch no env-scoped risk still run on an unlabelled project', () => {
    const accepted = presetRisks('read-only');
    expect(run('whoami', undefined, accepted)).toBe('allow');
    expect(run('listServices', undefined, accepted)).toBe('allow');
    expect(run('getLogs', undefined, accepted)).toBe('allow');
  });
});

// ─── `environmentId` is bound to the project the call is classified on ──────

describe('railway environmentId — must belong to the resolved project', () => {
  const accepted = [...presetRisks('operator'), 'railway.agent-action'];
  const other: Resource = {
    provider: 'railway',
    ref: OTHER_PROJECT,
    env: 'prod',
    displayName: 'billing',
    metadata: { environments: [{ id: OTHER_ENV_ID, name: 'production' }] },
  };
  const foreignEnvironment = `classify-denied: environmentId: not an environment of railway project '${PROJECT}'.`;

  test('accept-deploy on an environment of a project outside the mission is refused', () => {
    const verdict = decide(
      'railway__accept-deploy',
      { environmentId: OTHER_ENV_ID },
      [project('staging')],
      accepted,
    );
    expect(outcome(verdict)).toBe(foreignEnvironment);
  });

  test.each([
    ['railway__redeploy', { serviceId: SERVICE }],
    ['railway__railway-agent', { message: 'deploy' }],
    ['railway__list-variables', {}],
    ['railway__upsert-variable', { name: 'A', value: '1' }],
    ['railway__upsert-variables', { variables: { A: '1' } }],
    ['railway__delete-variable', { name: 'A' }],
    ['railway__get-logs', { serviceId: SERVICE }],
    ['railway__get-status', {}],
    ['railway__list-deployments', {}],
  ])('%s with an explicit projectId and a foreign environmentId is refused', (tool, extra) => {
    const args = { projectId: PROJECT, environmentId: OTHER_ENV_ID, ...extra };
    expect(outcome(decide(tool, args, [project('staging')], accepted))).toBe(foreignEnvironment);
    // Same refusal when the other project is in the mission : the two ids must agree.
    expect(outcome(decide(tool, args, [project('staging'), other], accepted))).toBe(
      foreignEnvironment,
    );
  });

  test('a call naming an environment is refused when the project has none discovered', () => {
    const undiscovered: Resource = {
      provider: 'railway',
      ref: PROJECT,
      env: 'staging',
      displayName: 'api',
    };
    const unknown =
      /^classify-denied: environmentId: the environments of railway project '.*' are unknown/;
    expect(
      outcome(
        decide('railway__accept-deploy', { environmentId: ENV_ID }, [undiscovered], accepted),
      ),
    ).toMatch(unknown);
    expect(
      outcome(decide(...CALLS.redeploy, [{ ...undiscovered, metadata: {} }], accepted)),
    ).toMatch(unknown);
    // Without an environmentId there is nothing to bind : project-wide reads still classify.
    expect(outcome(decide(...CALLS.listServices, [undiscovered], accepted))).toBe('allow');
  });

  test('accept-deploy without a usable environmentId is refused', () => {
    for (const environmentId of [undefined, 42, 'a b']) {
      const verdict = decide(
        'railway__accept-deploy',
        { environmentId },
        [project('staging')],
        accepted,
      );
      expect(outcome(verdict)).toMatch(/^classify-denied: environmentId: /);
    }
  });

  test('with two projects, accept-deploy is classified on the project owning the environment', () => {
    const args = { environmentId: OTHER_ENV_ID };
    const resources = [project('staging'), other];
    expect(
      outcome(decide('railway__accept-deploy', args, resources, ['railway[prod].deploy'])),
    ).toBe('allow');
    expect(
      outcome(decide('railway__accept-deploy', args, resources, ['railway[staging].deploy'])),
    ).toBe('deny: railway[prod].deploy');
  });
});
