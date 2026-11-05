/**
 * The plugin catalog of the site is the repository's `plugins/` folder:
 * every plugin folder is listed, the kit (`_template`) is not, and each is
 * read through its own entry module, as the gateway reads it.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ProviderPlugin } from '@vaubaan/plugin-sdk';
import {
  budgetAtTrustLevel,
  parseSlice,
  tierOf,
  TRUST_LEVEL_GATES,
  TRUST_LEVELS,
} from '@vaubaan/policy-engine';

import { ExampleError } from '../../../src/content/plugin-examples';
import { connectPageMarkdown } from '../../../src/content/plugin-pages';
import {
  discoverPluginDirs,
  importPlugin,
  loadPlugins,
  pluginInfo,
  UNDO_WORDS,
  type PluginInfo,
} from '../../../src/content/plugins';
import { REPO_ROOT } from '../../../src/content/repo';

const PLUGINS = join(REPO_ROOT, 'plugins');

function byId(id: string): PluginInfo {
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`no plugin '${id}'`);
  return plugin;
}

/** Written independently of the code under test: a folder with a package.json. */
function pluginFolders(): string[] {
  return readdirSync(PLUGINS)
    .filter((name) => statSync(join(PLUGINS, name)).isDirectory())
    .filter((name) => existsSync(join(PLUGINS, name, 'package.json')));
}

let plugins: PluginInfo[] = [];
let githubPlugin: ProviderPlugin | undefined;

beforeAll(async () => {
  plugins = await loadPlugins(REPO_ROOT);
  githubPlugin = await importPlugin(REPO_ROOT, 'plugins/github');
}, 60_000);

describe('the plugin catalog of the site', () => {
  it('lists every plugin folder of the repository but the kit', () => {
    const expected = pluginFolders()
      .filter((name) => name !== '_template')
      .map((name) => `plugins/${name}`)
      .sort();
    expect(discoverPluginDirs(REPO_ROOT)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('leaves out _template', () => {
    expect(pluginFolders()).toContain('_template');
    expect(discoverPluginDirs(REPO_ROOT)).not.toContain('plugins/_template');
    expect(plugins.map((p) => p.dir)).not.toContain('plugins/_template');
  });

  it('loads one plugin per folder, with its declaration and its catalog', () => {
    expect(plugins.map((p) => p.dir).sort()).toEqual(discoverPluginDirs(REPO_ROOT));
    expect(new Set(plugins.map((p) => p.id)).size).toBe(plugins.length);
    for (const plugin of plugins) {
      expect(plugin.version, plugin.id).toMatch(/^\d+\.\d+\.\d+/);
      expect(plugin.name, plugin.id).not.toBe('');
      expect(plugin.risks.length, plugin.id).toBeGreaterThan(0);
      expect(plugin.macroActions.length, plugin.id).toBeGreaterThan(0);
      expect(plugin.credentials.length, plugin.id).toBeGreaterThan(0);
      for (const risk of plugin.risks) {
        expect(risk.id.startsWith(plugin.id), risk.id).toBe(true);
        expect(['low', 'medium', 'high', 'critical']).toContain(risk.severity);
      }
      const ids = new Set(plugin.risks.map((r) => r.id));
      for (const action of plugin.macroActions) {
        expect(action.entries.length, action.id).toBeGreaterThan(0);
        for (const entry of action.entries) expect(ids.has(entry.riskId), entry.riskId).toBe(true);
      }
    }
  });

  it('exposes per permission the six facts, the undo word and the tier of the policy engine', () => {
    for (const plugin of plugins) {
      for (const risk of plugin.risks) {
        expect(Object.keys(risk.vector).sort(), risk.id).toEqual([
          'blast',
          'cost',
          'data',
          'persistence',
          'reversibility',
          'visibility',
        ]);
        expect(risk.tier, risk.id).toBe(tierOf(risk.vector));
        expect(risk.undo, risk.id).toBe(UNDO_WORDS[risk.vector.reversibility]);
        expect(risk.patterns.length, risk.id).toBeGreaterThan(0);
      }
    }
    const github = byId('github');
    const deleteRelease = github.risks.find((r) => r.id === 'github.delete-release');
    expect(deleteRelease?.undo).toBe('impossible');
    expect(deleteRelease?.tier).toBe(4);
    const retired = github.risks.find((r) => r.id === 'github.mint-install-token-push');
    expect(retired?.replacedBy).toBe('github.git-push');
  });

  it('carries the per-minute ceiling a catalog declares', () => {
    const ceilings = plugins.flatMap((p) => p.risks).filter((r) => r.rateCeilingPerMinute !== null);
    expect(ceilings.length).toBeGreaterThan(0);
    for (const risk of ceilings) expect(risk.rateCeilingPerMinute, risk.id).toBeGreaterThan(0);
  });

  it('gives an environment-scoped permission one variant per environment, with its own word and tier', () => {
    const deploy = byId('railway').risks.find((r) => r.id === 'railway.deploy');
    expect(deploy?.envVariants.map((v) => v.env)).toEqual(['staging', 'preview', 'dev', 'prod']);
    const staging = deploy?.envVariants.find((v) => v.env === 'staging');
    const prod = deploy?.envVariants.find((v) => v.env === 'prod');
    expect(staging).toMatchObject({ undo: 'easy', tier: 1, acceptable: true });
    expect(prod).toMatchObject({ undo: 'costly', tier: 3, acceptable: true });
    expect(prod?.vector.visibility).toBe('public');

    const entry = byId('railway')
      .macroActions.find((a) => a.id === 'deploy')
      ?.entries.find((e) => e.riskId === 'railway.deploy');
    const careful = (env: string) =>
      entry?.envLevels.find((row) => row.env === env)?.levels.careful.gate;
    expect(careful('staging')).toBe('auto');
    expect(careful('prod')).toBe('approval');
  });

  it('writes each macro-action entry out at the three trust levels, from the policy engine', () => {
    for (const plugin of plugins) {
      const risks = new Map(plugin.risks.map((r) => [r.id, r]));
      for (const action of plugin.macroActions) {
        expect(action.narrative, `${plugin.id}/${action.id}`).not.toBeNull();
        for (const entry of action.entries) {
          const risk = risks.get(entry.riskId);
          if (!risk) throw new Error(entry.riskId);
          for (const level of TRUST_LEVELS) {
            const budget = budgetAtTrustLevel(
              {
                quota: entry.quota,
                rate_limit: { max: entry.rateMax, window_seconds: entry.rateWindowSeconds },
              },
              level,
              risk.rateCeilingPerMinute,
            );
            expect(entry.levels[level], `${entry.riskId} ${level}`).toEqual({
              gate: TRUST_LEVEL_GATES[level][risk.tier],
              quota: budget.quota,
              rateMax: budget.rate_limit.max,
              rateWindowSeconds: budget.rate_limit.window_seconds,
            });
          }
        }
      }
    }
    const deleteRelease = byId('github')
      .macroActions.flatMap((a) => a.entries)
      .find((e) => e.riskId === 'github.delete-release');
    expect(deleteRelease?.levels.careful.gate).toBeNull();
    expect(deleteRelease?.levels.autonomous.gate).toBe('approval');
  });

  it('carries the icon, its colour, the resource noun and the tools left out', () => {
    const github = byId('github');
    expect(github.icon).not.toBeNull();
    expect(github.iconColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(github.resourceNoun).not.toBeNull();
    expect(github.excludedTools.length).toBeGreaterThan(0);
    for (const tool of github.excludedTools) {
      expect(github.tools.map((t) => t.name)).not.toContain(tool.name);
      expect(tool.reason).not.toBe('');
    }
  });

  it('says where the credential comes from: a pasted key, a client the gateway registers, a broker', () => {
    expect(byId('github').credentials[0]).toMatchObject({
      kind: 'api-key',
      clientSource: 'pasted-key',
      brokerProvider: null,
    });
    expect(byId('ssh').credentials[0]?.clientSource).toBe('pasted-key');
    expect(byId('miro').credentials[0]).toMatchObject({
      kind: 'oauth2',
      clientSource: 'gateway-registered',
      brokerProvider: null,
    });
    const calendar = byId('google-calendar').credentials[0];
    expect(calendar).toMatchObject({
      kind: 'oauth2',
      clientSource: 'broker',
      brokerProvider: 'google',
    });
    expect(calendar?.scopes).toHaveLength(2);
    const way = (id: string) =>
      /^### The way: .*$/m.exec(connectPageMarkdown(byId(id), ''))?.[0] ?? '';
    expect(way('google-calendar')).toMatch(/OAuth broker's client/);
    expect(way('google-calendar')).toContain('`google`');
    expect(way('google-calendar')).not.toMatch(/registers/);
    expect(way('miro')).toMatch(/the gateway registers its own client there/);
    expect(way('github')).toMatch(/pasted by hand/);
  });

  it('classifies the declared examples at build: a GitHub push touches git-push and the feature branch write', () => {
    const github = byId('github');
    expect(github.examples.length).toBeGreaterThan(0);
    const push = github.examples.find((e) => e.tool === 'github__git_push');
    expect(push?.slices.length).toBeGreaterThan(0);
    expect(push?.permissions).toEqual(
      expect.arrayContaining(['github.git-push', 'github.feature-branch-write']),
    );
    // The push also forces main and deletes a branch: not held by a Careful read + propose mission.
    expect(push?.careful.outcome).toBe('refused-not-held');
    expect(push?.careful.missing.length).toBeGreaterThan(0);
    const read = github.examples.find((e) => e.tool === 'github__list_branches');
    expect(read?.careful).toEqual({ outcome: 'runs', missing: [], asking: [] });
    // A sample the plugin expects its classifier to refuse is not a worked example.
    expect(github.examples.filter((e) => e.tool === 'github__git_push')).toHaveLength(1);
  });

  it('writes the worked mission from the first two macro-actions at Careful', () => {
    const github = byId('github');
    expect(github.workedMission.trustLevel).toBe('careful');
    expect(github.workedMission.macroActions).toEqual(
      github.macroActions.slice(0, 2).map((a) => a.id),
    );
    expect(github.workedMission.lines.length).toBeGreaterThan(0);
  });

  it('fails the build when a sample lands only on the fallback, or classify refuses it', () => {
    const github = githubPlugin;
    if (!github) throw new Error('github plugin not loaded');
    const fallbackOnly = {
      ...github,
      examples: { github__list_branches: [{ args: {} }] },
      classify: () => ({ slices: [parseSlice('github.nowhere[x].W')] }),
    } satisfies ProviderPlugin;
    expect(() => pluginInfo(fallbackOnly, 'plugins/github', 'x')).toThrow(ExampleError);
    expect(() => pluginInfo(fallbackOnly, 'plugins/github', 'x')).toThrow(/only on the fallback/);

    const refused = {
      ...github,
      examples: { github__list_branches: [{ args: {} }] },
      classify: () => ({ denied: 'no' }),
    } satisfies ProviderPlugin;
    expect(() => pluginInfo(refused, 'plugins/github', 'x')).toThrow(/classify refused it/);
  });

  it('carries no experimental state (docs/handbook/plugin-sdk.md)', () => {
    for (const plugin of plugins) expect(plugin, plugin.id).not.toHaveProperty('experimental');
  });

  it('the connect page of a token way says how wide to grant, the steps and the expiry', () => {
    const tokenWays = plugins.filter((p) => p.credentials.some((c) => c.kind === 'api-key'));
    expect(tokenWays.length).toBeGreaterThan(0);
    for (const plugin of tokenWays) {
      const page = connectPageMarkdown(plugin, '');
      expect(page, plugin.id).toMatch(/^How wide to grant — .+: .+\. .*mission/m);
      expect(page, plugin.id).toMatch(/^1\. /m);
      expect(page, plugin.id).toMatch(/^Expiry: /m);
      expect(page, plugin.id).not.toMatch(/and no more/);
    }
  });
});
