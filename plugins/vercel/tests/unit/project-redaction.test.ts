/**
 * SEC 2026-10-15 re-check H-1 : `vercel__get_project` (`data: metadata`)
 * returns the project without env values and without deploy-hook URLs;
 * unknown fields are redacted by default. `vercel__list_projects` answers the
 * mission's projects from the gateway's resources : id, name, framework, team.
 */
import { describe, expect, test } from 'vitest';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { VERCEL_API_BASE } from '../../src/identity.ts';
import { vercelPlugin } from '../../src/index.ts';
import { redactProjectPayload, redactProjectResult } from '../../src/project-redact.ts';
import { REDACTED_VALUE } from '../../src/redact.ts';
import { ctx, text } from './fixtures.ts';

const HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/prj_abc/hook-secret';

const PROJECT = {
  id: 'prj_abc',
  name: 'app',
  framework: 'nextjs',
  env: [
    { id: 'e1', key: 'DATABASE_URL', type: 'plain', value: 'postgres://u:pw@db' },
    {
      id: 'e2',
      key: 'STRIPE',
      type: 'encrypted',
      value: 'cipher-text-value',
      vsmValue: 'vsm-secret-value',
      legacyValue: 'legacy-secret-value',
    },
  ],
  link: {
    type: 'github',
    repo: 'web',
    org: 'acme',
    deployHooks: [{ id: 'h1', name: 'cms', ref: 'main', url: HOOK_URL }],
  },
  passwordProtection: { deploymentType: 'all', password: 'hunter2' },
  someFieldOfTomorrow: 'secret-of-tomorrow',
};

const LEAKS = [
  'postgres://u:pw@db',
  'cipher-text-value',
  'vsm-secret-value',
  'legacy-secret-value',
  HOOK_URL,
  'hunter2',
  'secret-of-tomorrow',
];

function expectNoLeak(serialized: string): void {
  for (const leak of LEAKS) expect(serialized).not.toContain(leak);
}

describe('redactProjectPayload', () => {
  test('one project : descriptive fields kept, values and hook URLs redacted', () => {
    const out = redactProjectPayload(PROJECT) as Record<string, unknown>;
    expect(out).toMatchObject({ id: 'prj_abc', name: 'app', framework: 'nextjs' });
    expect(out.someFieldOfTomorrow).toBe(REDACTED_VALUE);
    expect(out.passwordProtection).toBe(REDACTED_VALUE);
    expect(out.env).toEqual([
      { id: 'e1', key: 'DATABASE_URL', type: 'plain', value: REDACTED_VALUE },
      {
        id: 'e2',
        key: 'STRIPE',
        type: 'encrypted',
        value: REDACTED_VALUE,
        vsmValue: REDACTED_VALUE,
        legacyValue: REDACTED_VALUE,
      },
    ]);
    expect(out.link).toEqual({
      type: 'github',
      repo: 'web',
      org: 'acme',
      deployHooks: [{ id: 'h1', name: 'cms', ref: 'main', url: REDACTED_VALUE }],
    });
  });

  test('the list shapes : { projects, pagination }, a bare list, { project }', () => {
    const listed = redactProjectPayload({ projects: [PROJECT], pagination: { next: 1 } });
    expect((listed as { pagination: unknown }).pagination).toEqual({ next: 1 });
    expectNoLeak(JSON.stringify(listed));
    expectNoLeak(JSON.stringify(redactProjectPayload([PROJECT])));
    expectNoLeak(JSON.stringify(redactProjectPayload({ project: PROJECT })));
  });

  test('a text part that is not JSON is replaced whole (fail closed)', () => {
    const out = redactProjectResult({
      content: [{ type: 'text', text: `Project app: DATABASE_URL=postgres://u:pw@db` }],
    });
    expect(text(out)).toBe(REDACTED_VALUE);
  });
});

describe('executeVercel — project reads', () => {
  test('vercel__get_project', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc?teamId=team_abc`,
        body: PROJECT,
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__get_project', {});
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('prj_abc');
    expectNoLeak(serialized);
  });

  test('vercel__list_projects reads no project object : nothing to leak', async () => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_projects', {});
    expect(fetch.calls).toHaveLength(0);
    expect(JSON.parse(text(result))).toMatchObject({ projects: [{ id: 'prj_abc', name: 'app' }] });
  });
});

describe('executeVercel — update_project_settings answers the project redacted', () => {
  test('env values and deploy-hook URLs are redacted, the settings come back as they are', async () => {
    const settings = {
      framework: 'vite',
      rootDirectory: 'app',
      buildCommand: 'npm run build',
      devCommand: 'npm run dev',
      installCommand: 'npm ci',
      outputDirectory: 'dist',
      nodeVersion: '22.x',
    };
    const fetch = mockFetch([
      {
        method: 'PATCH',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc?teamId=team_abc`,
        body: { ...PROJECT, ...settings },
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__update_project_settings', {
      projectId: 'prj_abc',
      ...settings,
    });
    expect(result.isError).toBeFalsy();
    expectNoLeak(JSON.stringify(result));
    const answer = JSON.parse(text(result)) as Record<string, unknown>;
    expect(answer).toMatchObject({ id: 'prj_abc', name: 'app', ...settings });
    expect((answer.env as { value: unknown }[]).map((e) => e.value)).toEqual([
      REDACTED_VALUE,
      REDACTED_VALUE,
    ]);
    expect(answer.link).toMatchObject({
      deployHooks: [{ id: 'h1', name: 'cms', ref: 'main', url: REDACTED_VALUE }],
    });
  });
});
