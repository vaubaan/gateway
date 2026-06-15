/**
 * Tests — Railway v4 risk-based classifier.
 *
 * Spec : docs/spec/gateway-risk-model.md §3 (slice DSL), §7 (plugin
 *        contract). Research : .vaubaan/research/providers/railway-ssh.md
 *        §1.3 (tool → slice mapping), §1.6 (edge cases).
 *
 * Coverage targets :
 *  - Each of the 14 Railway tools emits the expected slice shape.
 *  - `upsert-variables` with `replace:true` emits a *wildcard* var leaf
 *    (matches the destructive `bulk-variables-replace` risk).
 *  - `upsert-variables` with `replace:false` emits a *list* var leaf
 *    (matches only the non-destructive upsert-variable risks).
 *  - `railway-agent` emits THREE slices in parallel (agent-session +
 *    deployment catch-all + service-var catch-all), so the token must
 *    accept ALL possible write risks the agent could touch.
 *  - Unknown tool → `denied`. Ambiguous binding → `denied`.
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding, Slice } from '@vaubaan/shared';

import { classifyRailwayV4 } from '../../src/risk-classifier.ts';
import { serializeSlice } from '@vaubaan/policy-engine';

// ─── Helpers ───────────────────────────────────────────────────────────────

const PROJECT = '00000000-0000-4000-8000-000000000001';
const SERVICE = '00000000-0000-4000-8000-000000000002';
const ENV_ID = '00000000-0000-4000-8000-000000000003';

function stagingBinding(): ProviderBinding {
  return {
    id: 'b-staging',
    project_id: 'p-1',
    provider: 'railway',
    resource_ref: PROJECT,
    display_name: 'railway-staging',
    environment: 'staging',
    created_at: '2026-01-01T00:00:00Z',
  };
}

function prodBinding(): ProviderBinding {
  return {
    id: 'b-prod',
    project_id: 'p-1',
    provider: 'railway',
    resource_ref: PROJECT,
    display_name: 'railway-prod',
    environment: 'prod',
    created_at: '2026-01-01T00:00:00Z',
  };
}

function ok(result: { slices: Slice[] } | { denied: string }): Slice[] {
  if ('denied' in result) {
    throw new Error(`expected slices, got denied: ${result.denied}`);
  }
  return result.slices;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

describe('classifyRailwayV4 — account-level reads', () => {
  test('whoami → single account[*].R slice (env-less)', () => {
    const slices = ok(classifyRailwayV4('railway__whoami', {}, []));
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ provider: 'railway', action: 'R' });
    // Path : name(account), wild-one
    expect(slices[0]!.path).toEqual([{ kind: 'name', value: 'account' }, { kind: 'wild-one' }]);
  });

  test('list-projects → account[*].project[*].R (env-less)', () => {
    const slices = ok(classifyRailwayV4('railway__list-projects', {}, []));
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('R');
    expect(slices[0]!.path).toEqual([
      { kind: 'name', value: 'account' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'project' },
      { kind: 'wild-one' },
    ]);
  });
});

describe('classifyRailwayV4 — project-scoped reads', () => {
  test('list-services stamps env from binding', () => {
    const slices = ok(
      classifyRailwayV4('railway__list-services', { projectId: PROJECT }, [stagingBinding()]),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('R');
    // project[<id>] then environment[*] then service[*] — env is wild for
    // *read* surface that spans environments.
    const text = serializeSlice(slices[0]!);
    expect(text).toContain(`project[${PROJECT}]`);
    expect(text).toContain('service');
  });

  test('get-logs : deployment[*].logs.R', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__get-logs',
        { projectId: PROJECT, serviceId: SERVICE, environmentId: ENV_ID },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toMatch(/logs\.R$/);
    expect(text).toContain(`service[${SERVICE}]`);
  });

  test('list-variables : env from binding stamped in slice', () => {
    const slices = ok(
      classifyRailwayV4('railway__list-variables', { projectId: PROJECT, environmentId: ENV_ID }, [
        prodBinding(),
      ]),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('environment[prod]'); // Vaubaan slug, not Railway native.
    expect(text).toMatch(/service-var\[\*\]\.R$/);
  });
});

// ─── Deploys ───────────────────────────────────────────────────────────────

describe('classifyRailwayV4 — deploys', () => {
  test('redeploy : deployment.W qualified by env=staging', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__redeploy',
        { projectId: PROJECT, serviceId: SERVICE, environmentId: ENV_ID },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('W');
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('environment[staging]');
    expect(text).toContain(`service[${SERVICE}]`);
    expect(text).toMatch(/deployment\.W$/);
  });

  test('accept-deploy : deployment.W with serviceId omitted → service[*]', () => {
    const slices = ok(
      classifyRailwayV4('railway__accept-deploy', { projectId: PROJECT, environmentId: ENV_ID }, [
        prodBinding(),
      ]),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('environment[prod]');
    expect(text).toContain('service[*]');
  });
});

// ─── Variables : the crucial replace=true / replace=false branching ────────

describe('classifyRailwayV4 — upsert-variables (replace branching)', () => {
  test('upsert-variables replace=true → service-var[*].W (wildcard / destructive)', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { FOO: 'a', BAR: 'b' },
          replace: true,
        },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    const seg = slices[0]!.path[slices[0]!.path.length - 1];
    expect(seg).toEqual({ kind: 'wild-one' });
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('service-var');
    expect(text).toMatch(/service-var\[\*\]\.W$/);
  });

  test('upsert-variables replace=false → service-var[K1,K2,…].W (bounded list)', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { FOO: 'a', BAR: 'b' },
          replace: false,
        },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    const seg = slices[0]!.path[slices[0]!.path.length - 1];
    // The order of object keys is the iteration order — stable on string keys.
    expect(seg).toEqual({ kind: 'list', values: ['FOO', 'BAR'] });
    const text = serializeSlice(slices[0]!);
    expect(text).toMatch(/service-var\[FOO,BAR\]\.W$/);
  });

  test('upsert-variables without replace flag defaults to non-destructive list', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { STRIPE_SECRET_KEY: 'sk_test_xxx' },
          // replace omitted ⇒ defaults to false.
        },
        [stagingBinding()],
      ),
    );
    const seg = slices[0]!.path[slices[0]!.path.length - 1];
    expect(seg).toEqual({ kind: 'list', values: ['STRIPE_SECRET_KEY'] });
  });

  test('upsert-variables replace=false with empty variables → falls back to wildcard', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__upsert-variables',
        { projectId: PROJECT, environmentId: ENV_ID, variables: {}, replace: false },
        [stagingBinding()],
      ),
    );
    // Empty bulk → pessimistic wildcard.
    const seg = slices[0]!.path[slices[0]!.path.length - 1];
    expect(seg).toEqual({ kind: 'wild-one' });
  });
});

describe('classifyRailwayV4 — single variable upsert/delete', () => {
  test('upsert-variable → service-var[<name>].W (list of one)', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__upsert-variable',
        { projectId: PROJECT, environmentId: ENV_ID, name: 'DATABASE_URL', value: 'postgres://' },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    const last = slices[0]!.path[slices[0]!.path.length - 1];
    expect(last).toEqual({ kind: 'list', values: ['DATABASE_URL'] });
  });

  test('delete-variable → service-var[<name>].W (list of one)', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__delete-variable',
        { projectId: PROJECT, environmentId: ENV_ID, name: 'OBSOLETE_VAR' },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('W');
    const last = slices[0]!.path[slices[0]!.path.length - 1];
    expect(last).toEqual({ kind: 'list', values: ['OBSOLETE_VAR'] });
  });
});

// ─── Account writes ────────────────────────────────────────────────────────

describe('classifyRailwayV4 — account writes', () => {
  test('create-project : account[*].project.W (env-less)', () => {
    const slices = ok(classifyRailwayV4('railway__create-project', { name: 'foo' }, []));
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('W');
    expect(slices[0]!.path).toEqual([
      { kind: 'name', value: 'account' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'project' },
    ]);
  });
});

// ─── Meta-tool : railway-agent — multi-slice pessimistic emission ──────────

describe('classifyRailwayV4 — railway-agent (meta-tool, pessimistic)', () => {
  test('railway-agent emits 3 slices : agent-session + deployment + service-var', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__railway-agent',
        { projectId: PROJECT, environmentId: ENV_ID, message: 'scale up the worker' },
        [stagingBinding()],
      ),
    );
    expect(slices).toHaveLength(3);

    // Slice 1 : account[*].agent-session.W — touches `railway.agent-action`.
    expect(slices[0]).toMatchObject({ action: 'W' });
    expect(slices[0]!.path).toEqual([
      { kind: 'name', value: 'account' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'agent-session' },
    ]);

    // Slice 2 : project[X].environment[Y].service[*].deployment.W — catch-all
    // for deploy-{staging,prod}.
    const text2 = serializeSlice(slices[1]!);
    expect(text2).toContain(`project[${PROJECT}]`);
    expect(text2).toContain('environment[staging]');
    expect(text2).toMatch(/deployment\.W$/);

    // Slice 3 : project[X].environment[Y].service[*].service-var[*].W —
    // catch-all for upsert-variable + bulk-variables-replace.
    const text3 = serializeSlice(slices[2]!);
    expect(text3).toContain(`project[${PROJECT}]`);
    expect(text3).toContain('environment[staging]');
    expect(text3).toMatch(/service-var\[\*\]\.W$/);
  });

  test('railway-agent on prod binding stamps env=prod in the catch-all slices', () => {
    const slices = ok(
      classifyRailwayV4(
        'railway__railway-agent',
        { projectId: PROJECT, environmentId: ENV_ID, message: 'fix the deploy' },
        [prodBinding()],
      ),
    );
    expect(slices).toHaveLength(3);
    const text2 = serializeSlice(slices[1]!);
    const text3 = serializeSlice(slices[2]!);
    expect(text2).toContain('environment[prod]');
    expect(text3).toContain('environment[prod]');
  });
});

// ─── Denied paths ──────────────────────────────────────────────────────────

describe('classifyRailwayV4 — denied paths', () => {
  test('unknown tool → denied', () => {
    const result = classifyRailwayV4('railway__yolo', {}, [stagingBinding()]);
    expect(result).toEqual({ denied: "unknown railway tool 'railway__yolo'." });
  });

  test('multiple bindings, no projectId arg → ambiguous denied', () => {
    const result = classifyRailwayV4('railway__list-services', {}, [
      stagingBinding(),
      { ...prodBinding(), resource_ref: '00000000-0000-4000-8000-000000000099' },
    ]);
    expect(result).toEqual({ denied: 'ambiguous railway target: specify projectId.' });
  });

  test('projectId arg not in bindings → denied', () => {
    const result = classifyRailwayV4(
      'railway__list-services',
      { projectId: 'unbound-project-id' },
      [stagingBinding()],
    );
    expect(result).toEqual({
      denied: "railway project 'unbound-project-id' is not bound to this project.",
    });
  });

  test('single binding auto-fills projectId', () => {
    const result = classifyRailwayV4('railway__list-services', {}, [stagingBinding()]);
    expect('slices' in result).toBe(true);
  });
});
