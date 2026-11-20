/**
 * What an agent reads of a tool is enough to call it : every argument the
 * plugin routes on is declared. Found in dogfood on 2026-11-20 : with three
 * Vercel projects in the mission, `get_deployment` refused a call without
 * `projectId` while its schema did not declare one.
 */
import { describe, expect, test } from 'vitest';

import { isAccountTool, UNBOUND_TOOLS } from '../../src/classify.ts';
import { vercelPlugin } from '../../src/index.ts';
import { PROJECT_ID_PROPERTY, toolAcceptsArgument } from '../../src/tools.ts';
import upstream from '../../src/upstream-tools.json' with { type: 'json' };

const projectRooted = vercelPlugin.tools.filter(
  (t) => !isAccountTool(t.name) && !UNBOUND_TOOLS.has(t.name),
);

describe('declared schemas — the routing arguments are declared', () => {
  test.each(projectRooted.map((t) => t.name))('%s declares projectId', (name) => {
    const tool = vercelPlugin.tools.find((t) => t.name === name)!;
    expect(tool.inputSchema.properties).toHaveProperty('projectId');
  });

  test('no tool requires teamId : the account team is always the one sent', () => {
    for (const tool of vercelPlugin.tools) {
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain('teamId');
    }
  });

  test('the added projectId says it takes an id or a name, and how to find them', () => {
    expect(PROJECT_ID_PROPERTY.description).toContain('`prj_…`) or its name');
    expect(PROJECT_ID_PROPERTY.description).toContain('vercel__list_projects');
  });

  test('a projectId the upstream schema lacks is declared to the agent, never forwarded', () => {
    const lacking = (
      upstream as ReadonlyArray<{ name: string; inputSchema: { properties?: object } }>
    )
      .filter((t) => !isAccountTool(t.name) && !('projectId' in (t.inputSchema.properties ?? {})))
      .map((t) => t.name);
    expect(lacking).toContain('vercel__get_deployment');
    expect(lacking).toContain('vercel__get_deployment_build_logs');
    for (const name of lacking.filter((n) => n !== 'vercel__deploy_to_vercel')) {
      // `deploy_to_vercel` has an open upstream schema : it has always received the project.
      expect(toolAcceptsArgument(name, 'projectId'), name).toBe(false);
    }
  });
});
