import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../compose/shipped-plugins';
import { enumerateCatalog } from '../missions/catalog-view';
import { RISK_KINDS } from '../missions/model';
import { ACME_CATALOG } from '../missions/testing';
import {
  presetAnchor,
  presetReferencePath,
  providerPath,
  riskAnchor,
  riskReferencePath,
  sectionPath,
} from './links';
import {
  dataModelTrees,
  describePattern,
  presetReferenceOf,
  providerCards,
  providerReference,
  riskExplainer,
} from './reference';

const registry = createRegistry(SHIPPED_PLUGINS);
const references = registry.ids.map((id) => {
  const reference = providerReference(registry, id);
  if (!reference) throw new Error(`no reference for ${id}`);
  return reference;
});

function referenceOf(id: string) {
  const found = references.find((reference) => reference.id === id);
  if (!found) throw new Error(`no reference for ${id}`);
  return found;
}

describe('links into the provider reference', () => {
  it('points a risk id at its catalog entry, whatever its environment', () => {
    expect(riskReferencePath('github.read-code')).toBe('/reference/github#risk-github.read-code');
    expect(riskReferencePath('supabase[staging].bulk-row-write')).toBe(
      '/reference/supabase#risk-supabase.bulk-row-write',
    );
    expect(riskReferencePath('cloudflare-dns.read-zone')).toBe(
      '/reference/cloudflare-dns#risk-cloudflare-dns.read-zone',
    );
    expect(riskReferencePath('not a risk id')).toBeNull();
  });

  it('builds the provider, preset and section paths', () => {
    expect(providerPath('upstash-redis')).toBe('/reference/upstash-redis');
    expect(presetReferencePath('github', 'developer')).toBe('/reference/github#preset-developer');
    expect(sectionPath('github', 'presets')).toBe('/reference/github#presets');
    expect(riskAnchor('github.read-code')).toBe('risk-github.read-code');
    expect(presetAnchor('developer')).toBe('preset-developer');
  });
});

describe('describePattern', () => {
  it('reads a pattern as an action and a path, identifiers in parentheses', () => {
    expect(describePattern('github.repo[**].branch[main,master,release-*].file[**].W')).toBe(
      'Write: repo (any) › branch (main, master, release-*) › file (any)',
    );
    expect(describePattern('github.repo[**].branch[**].merge-into.W')).toBe(
      'Write: repo (any) › branch (any) › merge-into',
    );
    expect(describePattern('github.search.code.R')).toBe('Read: search › code');
    expect(describePattern('supabase.project[*].schema[public].R')).toBe(
      'Read: project (any one) › schema (public)',
    );
  });

  it('names the catch-all write for what it is, and leaves an unparseable pattern as written', () => {
    expect(describePattern('github.**.W')).toBe('Write anything in github');
    expect(describePattern('acme.space[**].**.W')).toBe('Write: space (any) › anything below');
    expect(describePattern('not a pattern')).toBe('not a pattern');
  });
});

describe('dataModelTrees', () => {
  it('nests entities under their parent and marks the carrier of the environment', () => {
    const [plane] = dataModelTrees({
      provider: 'acme',
      planes: [
        {
          slug: 'store',
          description: 'Things in spaces.',
          entities: [
            { name: 'space', parent: null, cardinalities: ['one'], description: 'A space.' },
            {
              name: 'thing',
              parent: 'space',
              cardinalities: ['one', 'unbounded'],
              description: 'A thing.',
              envScopable: true,
            },
            { name: 'note', parent: 'thing', cardinalities: ['bounded'], description: 'A note.' },
            { name: 'settings', parent: 'space', cardinalities: ['one'], description: 'Settings.' },
          ],
        },
      ],
    });
    expect(plane).toMatchObject({
      slug: 'store',
      description: 'Things in spaces.',
      entity_count: 4,
    });
    expect(plane?.roots.map((node) => node.name)).toEqual(['space']);
    const [space] = plane?.roots ?? [];
    expect(space?.children.map((node) => node.name)).toEqual(['thing', 'settings']);
    expect(space?.children[0]).toMatchObject({ carries_env: true });
    expect(space?.children[0]?.children.map((node) => node.name)).toEqual(['note']);
    expect(space?.carries_env).toBe(false);
  });
});

describe('presetReferenceOf', () => {
  const risks = enumerateCatalog(ACME_CATALOG);
  const preset = (id: string) => {
    const found = ACME_CATALOG.presets?.find((p) => p.id === id);
    if (!found) throw new Error(`fixture preset ${id} missing`);
    return presetReferenceOf(found, risks);
  };

  it('splits the lines by gate, with the budget of each, and names what is left out', () => {
    const developer = preset('developer');
    expect(developer.auto.map((line) => line.risk.risk_id)).toEqual([
      'acme.read',
      'acme[staging].write',
    ]);
    expect(
      developer.approval.map((line) => [line.risk.risk_id, line.quota, line.rate_limit, line.gate]),
    ).toEqual([['acme[staging].bulk-delete', 5, { max: 1, window_seconds: 60 }, 'approval']]);
    // The prod variant of an entry accepted on staging only is "not included" too.
    expect(developer.not_included.map((family) => family.base_id)).toEqual([
      'acme.write',
      'acme.admin',
      'acme.legacy-export',
      'acme.uncategorized-write',
    ]);
    expect(developer.not_included[0]?.variants.map((risk) => risk.env)).toEqual(['prod']);
  });

  it('expands a base id to every environment of the catalog', () => {
    const writer = preset('writer');
    expect(writer.auto.map((line) => line.risk.risk_id)).toEqual([
      'acme[staging].write',
      'acme[prod].write',
    ]);
    expect(writer.approval).toEqual([]);
  });
});

describe('the reference of the shipped plugins', () => {
  it('has one card per plugin of the registry, experimental ones last', () => {
    const cards = providerCards(registry);
    expect(cards.map((card) => card.id).sort()).toEqual([...registry.ids].sort());
    const firstExperimental = cards.findIndex((card) => card.experimental);
    expect(cards.slice(firstExperimental).every((card) => card.experimental)).toBe(true);
    for (const card of cards) {
      expect(card.counts.risks).toBeGreaterThan(0);
      expect(card.counts.presets).toBeGreaterThan(0);
      expect(card.counts.risk_ids).toBeGreaterThanOrEqual(card.counts.risks);
    }
  });

  it('every shipped plugin says in plain words what it connects to', () => {
    for (const reference of references) {
      expect(reference.summary, `${reference.id}: summary`).toMatch(/One account is /);
      expect(reference.summary, `${reference.id}: summary`).toMatch(/resource/);
    }
  });

  it('lists every catalog entry exactly once, under a unique anchor', () => {
    for (const reference of references) {
      const entries = reference.risk_groups.flatMap((group) => group.entries);
      const catalog = registry.require(reference.id).plugin.catalog;
      expect(entries.map((entry) => entry.base_id).sort()).toEqual(
        catalog.risks.map((risk) => risk.id).sort(),
      );
      expect(new Set(entries.map((entry) => entry.anchor)).size).toBe(entries.length);
      for (const entry of entries) {
        expect(entry.label).not.toBe('');
        expect(entry.reason).not.toBe('');
        expect(entry.patterns.length).toBeGreaterThan(0);
        // Every pattern of a shipped catalog reads as words, not as the raw pattern.
        for (const { pattern, words } of entry.patterns) expect(words).not.toBe(pattern);
        expect(entry.variants.length).toBe(entry.env_scoped ? entry.envs.length : 1);
      }
      expect(entries.filter((entry) => entry.fallback)).toHaveLength(1);
    }
  });

  it('groups the entries reads first, and a read never writes', () => {
    for (const reference of references) {
      const kinds = reference.risk_groups.map((group) => group.kind);
      expect(kinds).toEqual(RISK_KINDS.filter((k) => kinds.includes(k)));
      const reads = reference.risk_groups.find((group) => group.kind === 'read')?.entries ?? [];
      for (const entry of reads) {
        expect(entry.patterns.every(({ pattern }) => pattern.endsWith('.R'))).toBe(true);
      }
    }
  });

  it('expands every preset to explicit catalog ids, never the fallback, with what it leaves out', () => {
    for (const reference of references) {
      const ids = new Set(
        enumerateCatalog(registry.require(reference.id).plugin.catalog).map((r) => r.risk_id),
      );
      expect(new Set(reference.presets.map((preset) => preset.anchor)).size).toBe(
        reference.presets.length,
      );
      for (const preset of reference.presets) {
        const lines = [...preset.auto, ...preset.approval];
        expect(lines.length, `${reference.id}/${preset.id}`).toBeGreaterThan(0);
        for (const line of lines) {
          expect(ids.has(line.risk.risk_id)).toBe(true);
          expect(line.risk.fallback).toBe(false);
          expect(line.quota).toBeGreaterThan(0);
        }
        const left = preset.not_included.flatMap((family) => family.variants);
        expect(lines.length + left.length).toBe(ids.size);
        // No preset includes the fallback: it is always among what is left out.
        expect(preset.not_included.some((family) => family.fallback)).toBe(true);
      }
    }
  });

  it('says where the environment of a call comes from', () => {
    expect(referenceOf('vercel').environment).toMatchObject({ source: 'call' });
    expect(referenceOf('supabase').environment.source).toBe('resource-label');
    expect(referenceOf('supabase').environment.envs).toContain('staging');
    // GitHub marks the branch as the carrier in its model, and has no env-scoped risk.
    expect(referenceOf('github').environment).toMatchObject({
      source: 'none',
      envs: [],
      carriers: ['repo.branch'],
    });
    expect(referenceOf('cloudflare-dns').environment).toMatchObject({
      source: 'none',
      carriers: [],
    });
  });

  it('describes each tool with its arguments, required apart from optional', () => {
    const tool = referenceOf('github').tools.find((t) => t.name === 'github__list_commits');
    expect(tool).toMatchObject({ required: ['owner', 'repo'], optional: ['sha', 'per_page'] });
    expect(tool?.description).not.toBe('');
  });

  it('marks the tools and risks that hand a provider token to the agent, from the plugin declaration', () => {
    const github = referenceOf('github');
    const mint = github.tools.find((t) => t.name === 'github__mint_install_token');
    expect(mint).toMatchObject({
      hands_token: true,
      declared_risks: ['github.mint-install-token-clone', 'github.mint-install-token-push'],
    });
    const handed = github.risk_groups
      .flatMap((group) => group.entries)
      .filter((entry) => entry.hands_token)
      .map((entry) => entry.base_id);
    expect(handed).toEqual(['github.mint-install-token-clone', 'github.mint-install-token-push']);
    // What the token can do, as the plugin declares it: a preset gates the write one.
    const access = Object.fromEntries(
      github.risk_groups
        .flatMap((group) => group.entries)
        .map((entry) => [entry.base_id, entry.token_access]),
    );
    expect(access['github.mint-install-token-clone']).toBe('read-only');
    expect(access['github.mint-install-token-push']).toBe('write');
    expect(access['github.read-code']).toBeNull();
    // No other tool states its risks: they depend on the arguments.
    expect(github.tools.filter((t) => t.declared_risks !== null)).toHaveLength(1);
    for (const reference of references.filter((r) => r.id !== 'github')) {
      expect(reference.tools.some((t) => t.hands_token)).toBe(false);
    }
  });

  it('says, on a card, the planes of the model and the environments of the catalog', () => {
    const cards = providerCards(registry);
    expect(cards.find((card) => card.id === 'supabase')).toMatchObject({
      plane_slugs: ['db', 'storage', 'auth', 'functions'],
      envs: ['preview', 'staging', 'prod'],
    });
    expect(cards.find((card) => card.id === 'github')).toMatchObject({
      plane_slugs: ['repo'],
      envs: [],
    });
  });

  it('names, on each risk, the presets that include it and the tools declared for it', () => {
    const github = referenceOf('github');
    const entries = github.risk_groups.flatMap((group) => group.entries);
    const byId = new Map(entries.map((entry) => [entry.base_id, entry]));
    expect(byId.get('github.read-code')?.presets.map((preset) => preset.id)).toEqual(
      github.presets.map((preset) => preset.id),
    );
    expect(byId.get('github.uncategorized-write')?.presets).toEqual([]);
    expect(byId.get('github.mint-install-token-push')).toMatchObject({
      declared_tools: ['github__mint_install_token'],
      presets: [{ id: 'developer', anchor: 'preset-developer' }],
    });
    // Both ways agree: a preset's lines are exactly the risks that name it.
    for (const reference of references) {
      for (const preset of reference.presets) {
        const lines = new Set(
          [...preset.auto, ...preset.approval].map((line) => line.risk.base_id),
        );
        const naming = reference.risk_groups
          .flatMap((group) => group.entries)
          .filter((entry) => entry.presets.some((tag) => tag.id === preset.id))
          .map((entry) => entry.base_id);
        expect(new Set(naming)).toEqual(lines);
      }
    }
  });

  it('answers null for a provider no plugin ships', () => {
    expect(providerReference(registry, 'no-such-provider')).toBeNull();
  });
});

describe('riskExplainer', () => {
  const explain = riskExplainer(registry);

  it('finds the catalog row of an explicit id, qualified or not', () => {
    expect(explain('github.read-code')).toMatchObject({ kind: 'read', env: null });
    const staging = explain('supabase[staging].bulk-row-write');
    expect(staging).toMatchObject({ base_id: 'supabase.bulk-row-write', env: 'staging' });
    expect(staging?.vector.blast).toBe('bulk');
  });

  it('answers null for an id no catalog declares', () => {
    expect(explain('github.no-such-risk')).toBeNull();
    expect(explain('supabase[prod].bulk-row-write')).toBeNull();
    expect(explain('nowhere.read')).toBeNull();
    expect(explain('not a risk id')).toBeNull();
  });
});
