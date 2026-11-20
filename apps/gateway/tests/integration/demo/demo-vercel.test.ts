/**
 * The demo simulates Vercel (handbook demo-mode): an account made with the
 * tour's values discovers the simulated team's two projects, and the shipped
 * plugin's tools are answered from memory. Runs the shipped plugin against the
 * demo's `fetch` double: no build, no listener.
 */
import type { Resource } from '@vaubaan/plugin-sdk';
import { vercelPlugin } from '@vaubaan/plugin-vercel';
import { describe, expect, it } from 'vitest';

import { createDemoServices, DEMO_VERCEL_PROJECTS, DEMO_VERCEL_TEAM } from '../../demo/services';

const credential = {
  kind: 'api-key' as const,
  metadata: {},
  fields: { token: 'demo-vercel-token', team_id: 'team_demo' },
};

async function connected() {
  const services = createDemoServices();
  const resources = await vercelPlugin.discoverResources({
    credential,
    fetch: services.fetch,
  });
  return { services, resources };
}

function textOf(result: { content: readonly unknown[] }): string {
  return result.content.map((part) => (part as { text?: string }).text ?? '').join('\n');
}

describe('demo: simulated Vercel', () => {
  it('discovers one team and its two projects, each with the three environments', async () => {
    const { resources } = await connected();
    expect(resources.map((r: Resource) => [r.ref, r.displayName])).toEqual(
      DEMO_VERCEL_PROJECTS.map((p) => [p.id, p.name]),
    );
    for (const resource of resources) {
      expect(resource.metadata).toMatchObject({
        team_id: 'team_demo',
        team_slug: DEMO_VERCEL_TEAM.slug,
        environments: ['prod', 'preview', 'development'],
      });
    }
  });

  it('answers a REST tool and a rewrapped tool of the shipped plugin', async () => {
    const { services, resources } = await connected();
    const [project] = DEMO_VERCEL_PROJECTS;
    const ctx = { credential, appConfig: {}, fetch: services.fetch, resources };

    const envs = await vercelPlugin.execute(ctx, 'vercel__list_env_vars', {
      projectId: project.id,
    });
    expect(envs.isError ?? false).toBe(false);
    expect(textOf(envs)).toContain('API_BASE_URL');

    // Served by the REST API (the plugin's `rest-reads.ts`), the project named by its name.
    const deployments = await vercelPlugin.execute(ctx, 'vercel__list_deployments', {
      projectId: project.name,
    });
    expect(deployments.isError ?? false).toBe(false);
    expect(textOf(deployments)).toContain('production');
    expect(textOf(deployments)).toContain('preview');

    const logs = await vercelPlugin.execute(ctx, 'vercel__get_runtime_logs', {
      projectId: project.id,
    });
    expect(logs.isError ?? false).toBe(false);
    expect(textOf(logs)).toContain('Build completed');
  });

  it('never dials the service: discovery was answered by simulated routes', async () => {
    const { services } = await connected();
    expect(services.calls.length).toBeGreaterThan(0);
    for (const call of services.calls) expect(call.method).toBe('GET');
  });
});
