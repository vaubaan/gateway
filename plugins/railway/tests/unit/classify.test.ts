/**
 * Tests — Railway classifier (`classifyRailway(tool, args, resources)`).
 *
 * Spec : docs/spec/gateway-risk-model.md §3 (slice DSL), §7 (plugin
 *        contract). Research : .vaubaan/research/services/railway-ssh.md
 *        §1.3 (tool → slice mapping), §1.6 (edge cases).
 *
 * Coverage targets :
 *  - Each of the 14 Railway tools emits the expected slice shape.
 *  - `upsert-variables` with `replace:true` emits a *wildcard* var leaf
 *    plus the `service-var-replace` marker slice (the only slice the
 *    destructive `bulk-variables-replace` risk matches).
 *  - `upsert-variables` with `replace:false` emits a *list* var leaf and
 *    no marker (matches only the non-destructive upsert-variable risk).
 *  - `railway-agent` emits FOUR slices in parallel (agent-session +
 *    deployment catch-all + service-var catch-all + replace marker), so
 *    the mission must accept ALL possible write risks the agent could touch.
 *  - Unknown tool → `denied`. Ambiguous target → `denied`.
 *
 * The decisions these slices lead to, mission by mission, are in
 * `policy.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import {
  serializeSlice,
  type ClassifyOutcome,
  type Resource,
  type Slice,
} from '@vaubaan/plugin-sdk';

import { classifyRailway } from '../../src/classify.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

const PROJECT = '00000000-0000-4000-8000-000000000001';
const SERVICE = '00000000-0000-4000-8000-000000000002';
const ENV_ID = '00000000-0000-4000-8000-000000000003';

/** What discovery stores on a project : the classifier binds `environmentId` and `serviceId` to it. */
const DISCOVERED = {
  environments: [{ id: ENV_ID, name: 'main' }],
  services: [{ id: SERVICE, name: 'api' }],
};

function stagingResource(): Resource {
  return {
    service: 'railway',
    ref: PROJECT,
    displayName: 'railway-staging',
    env: 'staging',
    metadata: DISCOVERED,
  };
}

function prodResource(): Resource {
  return {
    service: 'railway',
    ref: PROJECT,
    displayName: 'railway-prod',
    env: 'prod',
    metadata: DISCOVERED,
  };
}

function ok(result: ClassifyOutcome): readonly Slice[] {
  if ('denied' in result) {
    throw new Error(`expected slices, got denied: ${result.denied}`);
  }
  return result.slices;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

describe('classifyRailway — account-level reads', () => {
  test('whoami → single account[*].R slice (env-less)', () => {
    const slices = ok(classifyRailway('railway__whoami', {}, []));
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ service: 'railway', action: 'R' });
    // Path : name(account), wild-one
    expect(slices[0]!.path).toEqual([{ kind: 'name', value: 'account' }, { kind: 'wild-one' }]);
  });

  test('list-projects → account[*].project[*].R (env-less)', () => {
    const slices = ok(classifyRailway('railway__list-projects', {}, []));
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

describe('classifyRailway — project-scoped reads', () => {
  test('list-services names the project of the resource', () => {
    const slices = ok(
      classifyRailway('railway__list-services', { projectId: PROJECT }, [stagingResource()]),
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
      classifyRailway(
        'railway__get-logs',
        { projectId: PROJECT, serviceId: SERVICE, environmentId: ENV_ID },
        [stagingResource()],
      ),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toMatch(/logs\.R$/);
    expect(text).toContain(`service[${SERVICE}]`);
  });

  test('list-variables : env label of the resource stamped in slice', () => {
    const slices = ok(
      classifyRailway('railway__list-variables', { projectId: PROJECT, environmentId: ENV_ID }, [
        prodResource(),
      ]),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('environment[prod]'); // Vaubaan slug, not Railway native.
    expect(text).toMatch(/service-var\[\*\]\.R$/);
  });
});

// ─── Deploys ───────────────────────────────────────────────────────────────

describe('classifyRailway — deploys', () => {
  test('redeploy : deployment.W qualified by env=staging', () => {
    const slices = ok(
      classifyRailway(
        'railway__redeploy',
        { projectId: PROJECT, serviceId: SERVICE, environmentId: ENV_ID },
        [stagingResource()],
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
      classifyRailway('railway__accept-deploy', { projectId: PROJECT, environmentId: ENV_ID }, [
        prodResource(),
      ]),
    );
    expect(slices).toHaveLength(1);
    const text = serializeSlice(slices[0]!);
    expect(text).toContain('environment[prod]');
    expect(text).toContain('service[*]');
  });
});

// ─── Variables : the crucial replace=true / replace=false branching ────────

describe('classifyRailway — upsert-variables (replace branching)', () => {
  test('upsert-variables replace=true → service-var[*].W + the replace marker', () => {
    const slices = ok(
      classifyRailway(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { FOO: 'a', BAR: 'b' },
          replace: true,
        },
        [stagingResource()],
      ),
    );
    expect(slices.map(serializeSlice)).toEqual([
      `railway.project[${PROJECT}].environment[staging].service[${SERVICE}].service-var[*].W`,
      `railway.project[${PROJECT}].environment[staging].service[${SERVICE}].service-var-replace.W`,
    ]);
  });

  test('upsert-variables replace=false → service-var[K1,K2,…].W (bounded list)', () => {
    const slices = ok(
      classifyRailway(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { FOO: 'a', BAR: 'b' },
          replace: false,
        },
        [stagingResource()],
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
      classifyRailway(
        'railway__upsert-variables',
        {
          projectId: PROJECT,
          serviceId: SERVICE,
          environmentId: ENV_ID,
          variables: { STRIPE_SECRET_KEY: 'sk_test_xxx' },
          // replace omitted ⇒ defaults to false.
        },
        [stagingResource()],
      ),
    );
    const seg = slices[0]!.path[slices[0]!.path.length - 1];
    expect(seg).toEqual({ kind: 'list', values: ['STRIPE_SECRET_KEY'] });
  });

  test('upsert-variables replace=false with empty variables → treated as a replace', () => {
    const slices = ok(
      classifyRailway(
        'railway__upsert-variables',
        { projectId: PROJECT, environmentId: ENV_ID, variables: {}, replace: false },
        [stagingResource()],
      ),
    );
    // Empty bulk → pessimistic : wildcard leaf and the replace marker.
    expect(slices.map(serializeSlice)).toEqual([
      `railway.project[${PROJECT}].environment[staging].service[*].service-var[*].W`,
      `railway.project[${PROJECT}].environment[staging].service[*].service-var-replace.W`,
    ]);
  });

  test('upsert-variables with a replace flag that is not `false` → treated as a replace', () => {
    for (const replace of ['true', 'false', 1, 0, null]) {
      const slices = ok(
        classifyRailway(
          'railway__upsert-variables',
          { projectId: PROJECT, environmentId: ENV_ID, variables: { FOO: 'a' }, replace },
          [stagingResource()],
        ),
      );
      expect(slices).toHaveLength(2);
      expect(serializeSlice(slices[1]!)).toMatch(/service-var-replace\.W$/);
    }
  });
});

describe('classifyRailway — single variable upsert/delete', () => {
  test('upsert-variable → service-var[<name>].W (list of one)', () => {
    const slices = ok(
      classifyRailway(
        'railway__upsert-variable',
        { projectId: PROJECT, environmentId: ENV_ID, name: 'DATABASE_URL', value: 'postgres://' },
        [stagingResource()],
      ),
    );
    expect(slices).toHaveLength(1);
    const last = slices[0]!.path[slices[0]!.path.length - 1];
    expect(last).toEqual({ kind: 'list', values: ['DATABASE_URL'] });
  });

  test('delete-variable → service-var[<name>].W (list of one)', () => {
    const slices = ok(
      classifyRailway(
        'railway__delete-variable',
        { projectId: PROJECT, environmentId: ENV_ID, name: 'OBSOLETE_VAR' },
        [stagingResource()],
      ),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.action).toBe('W');
    const last = slices[0]!.path[slices[0]!.path.length - 1];
    expect(last).toEqual({ kind: 'list', values: ['OBSOLETE_VAR'] });
  });

  test('a missing or empty variable name is denied, never widened to a wildcard', () => {
    for (const tool of ['railway__upsert-variable', 'railway__delete-variable']) {
      for (const name of [undefined, '']) {
        expect(
          classifyRailway(tool, { projectId: PROJECT, environmentId: ENV_ID, name }, [
            stagingResource(),
          ]),
        ).toEqual({ denied: 'name: required.' });
      }
    }
  });
});

// ─── Account writes ────────────────────────────────────────────────────────

describe('classifyRailway — account writes', () => {
  test('create-project : account[*].project.W (env-less)', () => {
    const slices = ok(classifyRailway('railway__create-project', { name: 'foo' }, []));
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

describe('classifyRailway — railway-agent (meta-tool, pessimistic)', () => {
  test('railway-agent emits 4 slices : agent-session + deployment + service-var + replace marker', () => {
    const slices = ok(
      classifyRailway(
        'railway__railway-agent',
        { projectId: PROJECT, environmentId: ENV_ID, message: 'scale up the worker' },
        [stagingResource()],
      ),
    );
    expect(slices).toHaveLength(4);

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
    // catch-all for upsert-variable.
    const text3 = serializeSlice(slices[2]!);
    expect(text3).toContain(`project[${PROJECT}]`);
    expect(text3).toContain('environment[staging]');
    expect(text3).toMatch(/service-var\[\*\]\.W$/);

    // Slice 4 : project[X].environment[Y].service[*].service-var-replace.W —
    // the agent may replace every variable : bulk-variables-replace.
    expect(serializeSlice(slices[3]!)).toBe(
      `railway.project[${PROJECT}].environment[staging].service[*].service-var-replace.W`,
    );
  });

  test('railway-agent on a prod resource stamps env=prod in the catch-all slices', () => {
    const slices = ok(
      classifyRailway(
        'railway__railway-agent',
        { projectId: PROJECT, environmentId: ENV_ID, message: 'fix the deploy' },
        [prodResource()],
      ),
    );
    expect(slices).toHaveLength(4);
    for (const projectScoped of slices.slice(1)) {
      expect(serializeSlice(projectScoped)).toContain('environment[prod]');
    }
  });
});

// ─── Denied paths ──────────────────────────────────────────────────────────

describe('classifyRailway — denied paths', () => {
  test('unknown tool → denied', () => {
    const result = classifyRailway('railway__yolo', {}, [stagingResource()]);
    expect(result).toEqual({ denied: "unknown railway tool 'railway__yolo'." });
  });

  test('multiple resources, no projectId arg → ambiguous denied', () => {
    const result = classifyRailway('railway__list-services', {}, [
      stagingResource(),
      { ...prodResource(), ref: '00000000-0000-4000-8000-000000000099' },
    ]);
    expect('denied' in result && result.denied).toMatch(
      /^projectId: argument required — the mission touches 2 Railway projects — name one by its id or its name\. Projects of this mission: .+ \(00000000-0000-4000-8000-000000000099\)/,
    );
  });

  test('projectId arg not among the resources → denied', () => {
    const result = classifyRailway('railway__list-services', { projectId: 'unbound-project-id' }, [
      stagingResource(),
    ]);
    expect('denied' in result && result.denied).toMatch(
      /^railway project 'unbound-project-id' is not a resource of this mission\. Projects of this mission: /,
    );
  });

  test('single resource auto-fills projectId', () => {
    const result = classifyRailway('railway__list-services', {}, [stagingResource()]);
    expect('slices' in result).toBe(true);
  });
});
