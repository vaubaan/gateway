/**
 * Unit tests for `classifyVercel(tool, args, resources)` — the classifier.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the four classification rules (fan-out, delete-all-envs,
 *     bypass-token-mint, plaintext-read),
 *   - the custom REST tools surface (domains, project-settings, env-var CRUD),
 *   - what is refused : a projectId the mission does not hold, an unreadable
 *     `target`, the thread-addressed toolbar tools,
 *   - arguments the provider never sees do not select the risk
 *     (`deploy_to_vercel` is always on prod).
 *
 * Wherever possible, tests assert the *serialised* form via `serializeSlice`
 * to make the expected wire shape readable.
 */
import { describe, expect, test } from 'vitest';
import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyVercel } from '../../src/classify.ts';

const resource: Resource = { provider: 'vercel', ref: 'prj_abc', displayName: 'prj_abc' };

function classify(tool: string, args: Record<string, unknown> = {}) {
  const result = classifyVercel(tool, args, [resource]);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyVercel — reads', () => {
  test('search_vercel_documentation → account.docs.R', () => {
    expect(classify('vercel__search_vercel_documentation')).toEqual(['vercel.account.docs.R']);
  });

  test('list_teams → account.team[*].R', () => {
    expect(classify('vercel__list_teams')).toEqual(['vercel.account.team[*].R']);
  });

  test('list_projects → account.project[*].R', () => {
    expect(classify('vercel__list_projects')).toEqual(['vercel.account.project[*].R']);
  });

  test('get_project → project[prj_abc].project-settings.R', () => {
    expect(classify('vercel__get_project', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].project-settings.R',
    ]);
  });

  test('list_project_domains → project[prj_abc].domain[*].R', () => {
    expect(classify('vercel__list_project_domains', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].domain[*].R',
    ]);
  });

  test('list_deployments → project[prj_abc].deployment[*].R', () => {
    expect(classify('vercel__list_deployments', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].deployment[*].R',
    ]);
  });

  test('get_deployment with idOrUrl → project[prj_abc].deployment[dep_xyz].R', () => {
    expect(
      classify('vercel__get_deployment', { idOrUrl: 'dep_xyz', projectId: 'prj_abc' }),
    ).toEqual(['vercel.project[prj_abc].deployment[dep_xyz].R']);
  });

  test('get_runtime_logs → project[prj_abc].deployment[dep_xyz].runtime-log.R', () => {
    expect(
      classify('vercel__get_runtime_logs', { projectId: 'prj_abc', deploymentId: 'dep_xyz' }),
    ).toEqual(['vercel.project[prj_abc].deployment[dep_xyz].runtime-log.R']);
  });

  test('list_env_vars (decrypt=false) → single env-var read slice', () => {
    expect(classify('vercel__list_env_vars', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].env-var[*].R',
    ]);
  });
});

describe('classifyVercel — bug-fix #4 : decrypt=true emits plaintext slice', () => {
  test('list_env_vars decrypt=true → both env-var.R AND env-var.plaintext.R', () => {
    const slices = classify('vercel__list_env_vars', { projectId: 'prj_abc', decrypt: true });
    expect(slices).toContain('vercel.project[prj_abc].env-var[*].R');
    expect(slices).toContain('vercel.project[prj_abc].env-var[*].plaintext.R');
    expect(slices).toHaveLength(2);
  });
});

describe('classifyVercel — writes (deploy)', () => {
  test('deploy_to_vercel → env[prod].deployment.W : the upstream tool has no target', () => {
    expect(classify('vercel__deploy_to_vercel', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].env[prod].deployment.W',
    ]);
  });

  test('deploy_to_vercel with a `target` is refused : the tool takes none, and a deploy that reads "preview" would still go to prod', () => {
    for (const target of ['production', 'preview', 'development', 'staging', ['preview'], 42]) {
      expect(
        classifyVercel('vercel__deploy_to_vercel', { projectId: 'prj_abc', target }, [resource]),
      ).toEqual({
        denied:
          "target: not an argument of 'vercel__deploy_to_vercel' — nothing classifies it, so it is not sent.",
      });
    }
  });

  test('deploy_to_vercel without target → env[prod]', () => {
    expect(classify('vercel__deploy_to_vercel', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].env[prod].deployment.W',
    ]);
  });
});

describe('classifyVercel — bug-fix #3 : get_access_to_vercel_url is a credential mint', () => {
  test('emits bypass-token.W (not deployment.R)', () => {
    const slices = classify('vercel__get_access_to_vercel_url', {
      projectId: 'prj_abc',
      url: 'https://dep-foo.vercel.app/admin',
    });
    expect(slices).toEqual(['vercel.project[prj_abc].deployment[*].bypass-token.W']);
  });

  test('a `url` that is not an http(s) URL is denied, as `execute` refuses it', () => {
    expect(
      classifyVercel('vercel__get_access_to_vercel_url', { projectId: 'prj_abc', url: 'dep-foo' }, [
        resource,
      ]),
    ).toEqual({ denied: 'url: expected an absolute http(s) URL of a deployment.' });
  });

  test('non-ident URL value falls back to wildcard ident', () => {
    const slices = classify('vercel__get_access_to_vercel_url', {
      projectId: 'prj_abc',
      url: 'https://dep-foo.vercel.app/',
    });
    expect(slices).toEqual(['vercel.project[prj_abc].deployment[*].bypass-token.W']);
  });
});

describe('classifyVercel — bug-fix #1 : upsert_env_var fan-out', () => {
  test('target=[preview] → single env slice, no fan-out marker', () => {
    const slices = classify('vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'API_URL',
      value: 'x',
      target: ['preview'],
    });
    expect(slices).toEqual(['vercel.project[prj_abc].env[preview].env-var[API_URL].W']);
  });

  test('target=[production] → single prod slice, no fan-out', () => {
    const slices = classify('vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'STRIPE',
      value: 'x',
      target: ['production'],
    });
    expect(slices).toEqual(['vercel.project[prj_abc].env[prod].env-var[STRIPE].W']);
  });

  test('target=[production,preview,development] → 3 env slices + fan-out marker', () => {
    const slices = classify('vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'DB_URL',
      value: 'x',
      target: ['production', 'preview', 'development'],
    });
    expect(slices).toContain('vercel.project[prj_abc].env[prod].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env[preview].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env[development].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env-var-fan-out.W');
    expect(slices).toHaveLength(4);
  });

  test('target omitted → defaults to all 3 envs + fan-out marker', () => {
    const slices = classify('vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'DB_URL',
      value: 'x',
    });
    expect(slices).toContain('vercel.project[prj_abc].env[prod].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env[preview].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env[development].env-var[DB_URL].W');
    expect(slices).toContain('vercel.project[prj_abc].env-var-fan-out.W');
  });

  test('target=[] → all 3 envs + fan-out marker, as when omitted', () => {
    const slices = classify('vercel__upsert_env_var', { key: 'K', value: 'x', target: [] });
    expect(slices).toHaveLength(4);
    expect(slices).toContain('vercel.project[prj_abc].env-var-fan-out.W');
  });

  test.each([
    [['preview', 'Production']],
    [['preview', 'prod']],
    [['nope']],
    [['preview', 42]],
    [['preview', null]],
    [[['production']]],
    ['preview'],
    [null],
    [{ 0: 'preview' }],
    [true],
  ])('target=%j → refused, never classified on the readable part alone', (target) => {
    expect(
      classifyVercel('vercel__upsert_env_var', { key: 'K', value: 'x', target }, [resource]),
    ).toEqual({
      denied:
        "target: expected an array of 'production', 'preview' or 'development' (omit it for all three)",
    });
  });
});

describe('classifyVercel — bug-fix #2 : delete_env_var always touches all 3 envs', () => {
  test('delete_env_var with hint=preview → still emits 3 env slices + fan-out marker', () => {
    const slices = classify('vercel__delete_env_var', {
      projectId: 'prj_abc',
      id: 'env_xyz',
      target: 'preview',
    });
    expect(slices).toContain('vercel.project[prj_abc].env[prod].env-var[env_xyz].W');
    expect(slices).toContain('vercel.project[prj_abc].env[preview].env-var[env_xyz].W');
    expect(slices).toContain('vercel.project[prj_abc].env[development].env-var[env_xyz].W');
    expect(slices).toContain('vercel.project[prj_abc].env-var-fan-out.W');
    expect(slices).toHaveLength(4);
  });

  test('delete_env_var without target hint also fans out', () => {
    const slices = classify('vercel__delete_env_var', { projectId: 'prj_abc', id: 'env_xyz' });
    expect(slices).toHaveLength(4);
    expect(slices).toContain('vercel.project[prj_abc].env-var-fan-out.W');
  });
});

describe('classifyVercel — custom REST tools (project settings, domains, protection)', () => {
  test('update_project_settings → project[prj_abc].project-settings.W', () => {
    expect(
      classify('vercel__update_project_settings', { projectId: 'prj_abc', rootDirectory: 'app' }),
    ).toEqual(['vercel.project[prj_abc].project-settings.W']);
  });

  test('add_project_domain with ident-safe name → domain[NAME].W', () => {
    expect(
      classify('vercel__add_project_domain', { projectId: 'prj_abc', name: 'staging' }),
    ).toEqual(['vercel.project[prj_abc].domain[staging].W']);
  });

  test('add_project_domain with FQDN name → domain[*].W (FQDN not slice-safe)', () => {
    expect(
      classify('vercel__add_project_domain', { projectId: 'prj_abc', name: 'www.example.com' }),
    ).toEqual(['vercel.project[prj_abc].domain[*].W']);
  });

  test('verify_project_domain → domain.W', () => {
    expect(
      classify('vercel__verify_project_domain', { projectId: 'prj_abc', domain: 'staging' }),
    ).toEqual(['vercel.project[prj_abc].domain[staging].W']);
  });

  test('remove_project_domain → domain.W', () => {
    expect(
      classify('vercel__remove_project_domain', { projectId: 'prj_abc', domain: 'staging' }),
    ).toEqual(['vercel.project[prj_abc].domain[staging].W']);
  });
});

describe('classifyVercel — toolbar surface', () => {
  test('list_toolbar_threads → toolbar-thread[*].R under the mission project', () => {
    expect(classify('vercel__list_toolbar_threads', { projectId: 'prj_abc' })).toEqual([
      'vercel.project[prj_abc].deployment[*].toolbar-thread[*].R',
    ]);
  });

  // The thread-addressed tools are refused : see binding.test.ts.
});

describe('classifyVercel — one spelling per argument, the one of the schema', () => {
  test('project_id is not an argument : it names no project, and the call that carries it is refused', () => {
    expect(classifyVercel('vercel__get_project', { project_id: 'prj_other' }, [resource])).toEqual({
      denied:
        "project_id: not an argument of 'vercel__get_project' — nothing classifies it, so it is not sent.",
    });
    // The project is resolved first : with two projects the missing `projectId` is what is said.
    expect(
      classifyVercel('vercel__get_project', { project_id: 'prj_abc' }, [
        resource,
        { provider: 'vercel', ref: 'prj_site', displayName: 'site' },
      ]),
    ).toEqual({
      denied: 'projectId: argument missing and the mission touches 2 Vercel projects — name one',
    });
  });

  test('verify / remove read `domain`, add reads `name`', () => {
    // The other spelling is not read : the domain is missing, and `execute`
    // would refuse the call for the same reason.
    expect(
      classifyVercel('vercel__verify_project_domain', { name: 'staging' }, [resource]),
    ).toEqual({ denied: 'domain: missing or malformed domain name' });
    expect(classifyVercel('vercel__add_project_domain', { domain: 'staging' }, [resource])).toEqual(
      {
        denied: 'name: missing or malformed domain name',
      },
    );
  });
});

describe('classifyVercel — denials', () => {
  test('unknown tool → denied', () => {
    const result = classifyVercel('vercel__bogus', {}, [resource]);
    expect(result).toEqual({ denied: "unknown vercel tool 'vercel__bogus'." });
  });

  test('projectId outside the mission resources → denied', () => {
    const result = classifyVercel('vercel__get_project', { projectId: 'prj_unbound' }, [resource]);
    expect(result).toEqual({
      denied: "vercel project 'prj_unbound' is not a resource of this mission.",
    });
  });
});
