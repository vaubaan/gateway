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
  ANYTHING_ELSE_BASE_BUDGET,
  budgetAtTrustLevel,
  gateWordOf,
  parseSlice,
  REASON_AXIS,
  reasonOf,
  rowOf,
  TRUST_LEVEL_GATES,
  TRUST_LEVELS,
  WHY_ORDER,
  WHY_VALUES,
} from '@vaubaan/policy-engine';

import { ExampleError } from '../../../src/content/plugin-examples';
import { screenshotCredits } from '../../../src/content/plugin-page';
import { connectSectionMarkdown } from '../../../src/content/plugin-pages';
import {
  connectFigureFiles,
  discoverPluginDirs,
  importPlugin,
  loadPlugins,
  pluginInfo,
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
        expect([1, 2, 3, 4]).toContain(risk.row);
        expect(risk).not.toHaveProperty('severity');
      }
      const ids = new Set(plugin.risks.map((r) => r.id));
      for (const action of plugin.macroActions) {
        expect(action.entries.length, action.id).toBeGreaterThan(0);
        for (const entry of action.entries) expect(ids.has(entry.riskId), entry.riskId).toBe(true);
      }
    }
  });

  it('exposes per permission the five facts, the undo word, the row and its reason of the policy engine', () => {
    for (const plugin of plugins) {
      for (const risk of plugin.risks) {
        expect(Object.keys(risk.vector).sort(), risk.id).toEqual([
          'blast',
          'cost',
          'data',
          'reversibility',
          'visibility',
        ]);
        expect(risk.row, risk.id).toBe(rowOf(risk.vector));
        expect(risk.rowReason, risk.id).toBe(reasonOf(risk.vector));
        expect(risk.undo, risk.id).toBe(WHY_VALUES.reversibility[risk.vector.reversibility]);
        expect(
          risk.facts.map((f) => f.axis),
          risk.id,
        ).toEqual(WHY_ORDER);
        expect(
          risk.facts.filter((f) => f.movesGate).map((f) => f.axis),
          risk.id,
        ).toEqual(risk.rowReason === null ? [] : [REASON_AXIS[risk.rowReason]]);
        expect(risk.patterns.length, risk.id).toBeGreaterThan(0);
      }
    }
    const github = byId('github');
    const deleteRelease = github.risks.find((r) => r.id === 'github.delete-release');
    expect(deleteRelease?.undo).toBe('impossible');
    expect(deleteRelease?.row).toBe(4);
    const retired = github.risks.find((r) => r.id === 'github.mint-install-token-push');
    expect(retired?.replacedBy).toBe('github.git-push');
  });

  it('carries the per-minute ceiling a catalog declares', () => {
    const ceilings = plugins.flatMap((p) => p.risks).filter((r) => r.rateCeilingPerMinute !== null);
    expect(ceilings.length).toBeGreaterThan(0);
    for (const risk of ceilings) expect(risk.rateCeilingPerMinute, risk.id).toBeGreaterThan(0);
  });

  it('gives an environment-scoped permission one variant per environment, with its own word and row', () => {
    const deploy = byId('railway').risks.find((r) => r.id === 'railway.deploy');
    expect(deploy?.envVariants.map((v) => v.env)).toEqual(['staging', 'preview', 'dev', 'prod']);
    const staging = deploy?.envVariants.find((v) => v.env === 'staging');
    const prod = deploy?.envVariants.find((v) => v.env === 'prod');
    expect(staging).toMatchObject({
      undo: 'easy',
      row: 2,
      rowReason: 'moderate-cost',
      acceptable: true,
    });
    expect(prod).toMatchObject({ undo: 'costly', row: 3, acceptable: true });
    expect(prod?.vector.visibility).toBe('public');

    const entry = byId('railway')
      .macroActions.find((a) => a.id === 'deploy')
      ?.entries.find((e) => e.riskId === 'railway.deploy');
    const careful = (env: string) =>
      entry?.envLevels.find((row) => row.env === env)?.levels.careful.gate;
    // A deploy spends compute: it asks first at Careful in every environment (2026-11-13).
    expect(careful('staging')).toBe('approval');
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
            const gate = TRUST_LEVEL_GATES[level][risk.row];
            expect(entry.levels[level], `${entry.riskId} ${level}`).toEqual({
              gate,
              gateWord: gate === null ? 'off' : gateWordOf(gate),
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
    const section = (id: string) => connectSectionMarkdown(byId(id));
    expect(section('google-calendar')).toMatch(
      /^\*\*3 of 3 · you sign in through an OAuth broker\*\*/,
    );
    expect(section('google-calendar')).toMatch(/OAuth broker/);
    expect(section('google-calendar')).toContain('`google`');
    expect(section('google-calendar')).not.toMatch(/registers/);
    expect(section('miro')).toMatch(/^\*\*2 of 3 · you sign in and allow the gateway/);
    expect(section('miro')).toMatch(/The gateway registers its own client at the service/);
    expect(section('github')).toMatch(/^\*\*1 of 3 · a key you create and paste\*\*/);
    expect(section('ssh')).toMatch(/^\*\*1 of 3 · a key you create and paste\*\*/);
    expect(section('ssh')).toMatch(/key pair/);
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
    expect(push?.inWorkedMission.outcome).toBe('refused-not-held');
    expect(push?.inWorkedMission.missing.length).toBeGreaterThan(0);
    const read = github.examples.find((e) => e.tool === 'github__list_branches');
    expect(read?.inWorkedMission).toEqual({ outcome: 'runs', missing: [], asking: [] });
    expect(read?.atCareful.outcome).toBe('runs');
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
    // Can / Asks first / Cannot are the policy engine's lines and left-outs, read as the gateway reads them.
    for (const plugin of plugins) {
      const mission = plugin.workedMission;
      expect(mission.can, plugin.id).toEqual(
        mission.lines.filter((l) => l.gate === 'auto').map((l) => l.riskId),
      );
      expect(mission.asksFirst, plugin.id).toEqual(
        mission.lines.filter((l) => l.gate === 'approval').map((l) => l.riskId),
      );
      expect(mission.cannot, plugin.id).toEqual(mission.leftOut.map((l) => l.riskId));
      // Context7's one permission cannot be undone: Careful leaves it out, the mission is all "Cannot".
      expect(
        mission.can.length + mission.asksFirst.length + mission.cannot.length,
        plugin.id,
      ).toBeGreaterThan(0);
    }
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

  it('names the plugin, the tool and the sample when the build fails', () => {
    const github = githubPlugin;
    if (!github) throw new Error('github plugin not loaded');
    const second = {
      ...github,
      examples: { github__list_branches: [{ args: {} }, { args: { nowhere: true } }] },
      classify: (_tool: string, args: Readonly<Record<string, unknown>>) =>
        args['nowhere'] === true
          ? { slices: [parseSlice('github.nowhere[x].W')] }
          : github.classify('github__list_branches', { owner: 'o', repo: 'r' }, []),
    } satisfies ProviderPlugin;
    expect(() => pluginInfo(second, 'plugins/github', 'x')).toThrow(
      /plugin 'github'[\s\S]*'github__list_branches' sample #2 slice #1: 'github\.nowhere\[x\]\.W' lands only on the fallback/,
    );
  });

  it('says what a Careful mission does with each example, gate by gate, from the policy engine', () => {
    for (const plugin of plugins) {
      const risks = new Map(plugin.risks.map((r) => [r.id, r]));
      for (const example of plugin.examples) {
        const where = `${plugin.id} ${example.tool} #${example.sample}`;
        expect(example.atCareful.gates.length, where).toBeGreaterThan(0);
        for (const { riskId, gate } of example.atCareful.gates) {
          const base = risks.get(riskId.replace(/\[[^\]]*\]/, ''));
          if (base === undefined) throw new Error(`${where}: ${riskId}`);
          if (base.envVariants.length === 0) {
            expect(gate, `${where} ${riskId}`).toBe(TRUST_LEVEL_GATES.careful[base.row]);
          }
        }
        const gates = example.atCareful.gates.map((g) => g.gate);
        const expected = gates.includes(null)
          ? 'cannot'
          : gates.includes('approval')
            ? 'asks-first'
            : 'runs';
        expect(example.atCareful.outcome, where).toBe(expected);
      }
    }
    const deleteRelease = byId('github').examples.find((e) =>
      e.permissions.includes('github.delete-release'),
    );
    expect(deleteRelease?.atCareful.outcome).toBe('cannot');
  });

  it('opens each page with the counts: 17 GitHub permissions, neither the fallback nor the retired', () => {
    const github = byId('github');
    expect(github.counts).toEqual({
      permissions: 17,
      macroActions: github.macroActions.length,
      tools: github.tools.length,
      excludedTools: github.excludedTools.length,
      examples: github.examples.length,
    });
    expect(github.retired).toEqual([
      'github.mint-install-token-clone',
      'github.mint-install-token-push',
    ]);
    for (const plugin of plugins) {
      expect(plugin.counts.permissions, plugin.id).toBe(
        plugin.risks.filter((r) => !r.fallback && !r.deprecated).length,
      );
    }
  });

  it('lists each macro-action’s permissions in catalog order, retired ones left out', () => {
    for (const plugin of plugins) {
      const order = plugin.risks.map((r) => r.id);
      const retired = new Set(plugin.retired);
      for (const action of plugin.macroActions) {
        const ids = action.entries.map((e) => e.riskId);
        expect(ids, `${plugin.id}/${action.id}`).toEqual(
          [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
        );
        for (const id of ids) expect(retired.has(id), id).toBe(false);
      }
    }
  });

  it('holds the fallback in "Anything else", at the gateway’s base budget', () => {
    for (const plugin of plugins) {
      const fallbacks = plugin.risks.filter((r) => r.fallback).map((r) => r.id);
      const anythingElse = plugin.anythingElse;
      expect(anythingElse?.id, plugin.id).toBe('anything-else');
      expect(anythingElse?.label, plugin.id).toBe('Anything else');
      expect(
        anythingElse?.entries.map((e) => e.riskId),
        plugin.id,
      ).toEqual(fallbacks);
      for (const entry of anythingElse?.entries ?? []) {
        expect(entry.quota).toBe(ANYTHING_ELSE_BASE_BUDGET.quota);
        expect(entry.rateMax).toBe(ANYTHING_ELSE_BASE_BUDGET.rate_limit.max);
      }
      expect(
        plugin.macroActions.map((a) => a.id),
        plugin.id,
      ).not.toContain('anything-else');
    }
  });

  it('says what each tool usually touches, from its classified examples', () => {
    for (const plugin of plugins) {
      const ids = new Set(plugin.risks.map((r) => r.id));
      for (const tool of plugin.tools) {
        const fromExamples = new Set(
          plugin.examples.filter((e) => e.tool === tool.name).flatMap((e) => e.permissions),
        );
        expect(new Set(tool.touches), `${plugin.id} ${tool.name}`).toEqual(fromExamples);
        for (const id of tool.touches) expect(ids.has(id), id).toBe(true);
      }
    }
    const listBranches = byId('github').tools.find((t) => t.name === 'github__list_branches');
    expect(listBranches?.touches.length).toBeGreaterThan(0);
  });

  it('takes the three new plugins through every path: examples, narratives, the connect way', () => {
    for (const id of ['axonaut', 'asana', 'outlook']) {
      const plugin = byId(id);
      expect(plugin.examples.length, id).toBeGreaterThan(0);
      expect(
        plugin.tools.every((t) => t.touches.length > 0),
        id,
      ).toBe(true);
      for (const action of plugin.macroActions) expect(action.narrative, action.id).not.toBeNull();
      expect(plugin.workedMission.lines.length, id).toBeGreaterThan(0);
      expect(plugin.anythingElse, id).not.toBeNull();
    }
    expect(byId('axonaut').credentials[0]?.clientSource).toBe('pasted-key');
    expect(byId('asana').credentials[0]?.clientSource).toBe('pasted-key');
    expect(byId('outlook').credentials[0]).toMatchObject({
      kind: 'oauth2',
      clientSource: 'broker',
    });
  });

  it('gives a pasted key’s permissions with the tools that need each, and the manual revocation', () => {
    const github = byId('github');
    const way = github.credentials[0];
    expect(way?.permissions.length).toBeGreaterThan(0);
    // A permission may serve the git remote's operations (`github__git_fetch`), not only MCP tools.
    for (const permission of way?.permissions ?? []) {
      expect(permission.tools.length, permission.name).toBeGreaterThan(0);
    }
    const contents = way?.permissions.find((p) => p.tools.includes('github__get_file_contents'));
    expect(contents).toBeDefined();
    expect(way?.steps.length).toBeGreaterThan(0);
    expect(way?.reach).not.toBeNull();
    expect(way?.expiry).not.toBeNull();
    expect(way?.docsUrl).toMatch(/^https:/);
    for (const plugin of plugins) {
      expect(plugin.credentials[0]?.manualRevocation, plugin.id).toBe(plugin.manualRevocation);
    }
  });

  it('carries no experimental state (docs/handbook/plugin-sdk.md)', () => {
    for (const plugin of plugins) expect(plugin, plugin.id).not.toHaveProperty('experimental');
  });

  it('the connect guide of a token way says how wide to grant, the steps and the expiry', () => {
    const tokenWays = plugins.filter((p) => p.credentials.some((c) => c.kind === 'api-key'));
    expect(tokenWays.length).toBeGreaterThan(0);
    for (const plugin of tokenWays) {
      const page = connectSectionMarkdown(plugin);
      // The reach, headed by what it is: "**Repository access** — All repositories. …".
      expect(page, plugin.id).toMatch(/^\*\*.+\*\* — .+\. .*mission/m);
      expect(page, plugin.id).toMatch(/^1\. /m);
      expect(page, plugin.id).toMatch(/^Expiry: /m);
      expect(page, plugin.id).not.toMatch(/and no more/);
    }
  });

  it('every step of a token guide carries its menu path, written in bold in the twin', () => {
    const github = byId('github');
    const steps = github.credentials[0]?.steps ?? [];
    expect(steps.some((step) => step.path.includes('Developer settings'))).toBe(true);
    expect(connectSectionMarkdown(github)).toMatch(
      /^\d+\. \*\*Settings › Developer settings › Personal access tokens › .+\*\* — /m,
    );
  });

  it('a screenshot is copied beside the page, shown with its provenance line and credited', () => {
    const cloudflare = byId('cloudflare-dns');
    const figure = cloudflare.credentials[0]?.steps.find((step) => step.figure)?.figure;
    expect(figure).toMatchObject({
      src: '/plugins/cloudflare-dns/connect/create-token.webp',
      sourceHost: 'developers.cloudflare.com',
      licence: 'CC-BY-4.0',
      attribution: 'Cloudflare DNS docs, 2026-11 · from developers.cloudflare.com (CC BY 4.0)',
    });
    expect(connectFigureFiles(cloudflare)).toEqual([
      [
        'plugins/cloudflare-dns/connect/create-token.webp',
        'plugins/cloudflare-dns/docs/connect/create-token.webp',
      ],
    ]);
    const twin = connectSectionMarkdown(cloudflare);
    expect(twin).toContain('![The Create Token form');
    expect(twin).toContain('(/plugins/cloudflare-dns/connect/create-token.webp)');
    expect(twin).toContain(
      '*Cloudflare DNS docs, 2026-11 · from developers.cloudflare.com (CC BY 4.0)*',
    );
    expect(screenshotCredits(plugins)).toBe(
      "Screenshots on these pages come from the services' own documentation where its licence allows it: Cloudflare DNS docs, developers.cloudflare.com (CC BY 4.0).",
    );
    expect(screenshotCredits([byId('github')])).toBeNull();
  });

  it('keeps the shapes of a key apart: each alternative its own steps, the guide’s steps shared', async () => {
    const vercel = byId('vercel');
    const c = vercel.credentials[0]!;
    const plugin = await importPlugin(REPO_ROOT, 'plugins/vercel');
    const spec = plugin.credential;
    if (spec.kind !== 'api-key') throw new Error('vercel: expected an api-key way');
    expect(c.alternatives.map((a) => a.id)).toEqual((spec.alternatives ?? []).map((a) => a.id));
    expect(c.alternatives.length).toBeGreaterThanOrEqual(2);
    for (const [i, alt] of c.alternatives.entries()) {
      expect(alt.steps.map((s) => s.do)).toEqual(spec.alternatives![i]!.steps.map((s) => s.do));
      expect(alt.label).toBe(spec.alternatives![i]!.label);
    }
    expect(c.steps.map((s) => s.do)).toEqual(spec.guide.steps.map((s) => s.do));
    // A key of one shape has no alternative.
    expect(byId('github').credentials[0]?.alternatives).toEqual([]);
  });
});

describe('the data model of a plugin page', () => {
  it('is the plugin’s own dataModel: planes, entities, parents, cardinalities, descriptions', async () => {
    for (const dir of discoverPluginDirs(REPO_ROOT)) {
      const plugin = await importPlugin(REPO_ROOT, dir);
      const info = byId(plugin.id);
      expect(
        info.dataModel.planes.map((p) => ({
          slug: p.slug,
          description: p.description,
          entities: p.entities.map((e) => ({
            name: e.name,
            parent: e.parent,
            cardinalities: e.cardinalities,
            description: e.description,
            carriesEnv: e.carriesEnv,
          })),
        })),
        plugin.id,
      ).toEqual(
        plugin.dataModel.planes.map((p) => ({
          slug: p.slug,
          description: p.description ?? null,
          entities: p.entities.map((e) => ({
            name: e.name,
            parent: e.parent,
            cardinalities: [...e.cardinalities],
            description: e.description,
            carriesEnv: e.envScopable === true,
          })),
        })),
      );
    }
  }, 60_000);

  it('marks an entity touched when a classified example’s slice names it', () => {
    const github = byId('github');
    const entities = github.dataModel.planes.flatMap((p) => p.entities);
    const named = new Set(
      github.examples.flatMap((e) =>
        e.slices.flatMap((s) =>
          parseSlice(s).path.flatMap((seg) => (seg.kind === 'name' ? [seg.value] : [])),
        ),
      ),
    );
    for (const e of entities) expect(e.touched, e.name).toBe(named.has(e.name));
    expect(entities.find((e) => e.name === 'branch')?.touched).toBe(true);
    expect(entities.some((e) => !e.touched)).toBe(true);
  });

  it('says where the environment comes from, as the gateway reference decides it', async () => {
    expect(byId('vercel').environment.source).toBe('call');
    expect(byId('supabase').environment).toMatchObject({
      source: 'resource-label',
      envs: ['preview', 'staging', 'prod'],
      carriers: ['db.project', 'storage.project', 'auth.project', 'functions.project'],
    });
    expect(byId('github').environment).toEqual({
      source: 'none',
      envs: [],
      carriers: ['repo.branch'],
    });
    const vercel = await importPlugin(REPO_ROOT, 'plugins/vercel');
    expect(typeof vercel.envOf).toBe('function');
  });

  it('points at the file that declares the examples', () => {
    for (const plugin of plugins) {
      if (plugin.examplesSource === null) continue;
      expect(existsSync(join(REPO_ROOT, plugin.examplesSource)), plugin.id).toBe(true);
    }
    expect(byId('github').examplesSource).toBe('plugins/github/src/examples.ts');
  });
});
