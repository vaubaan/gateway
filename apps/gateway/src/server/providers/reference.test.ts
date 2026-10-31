import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../compose/shipped-plugins';
import { RISK_KINDS } from '../missions/model';
import {
  macroActionAnchor,
  macroActionReferencePath,
  providerPath,
  riskAnchor,
  riskReferencePath,
  sectionPath,
} from './links';
import {
  dataModelTrees,
  describePattern,
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

  it('builds the provider, macro-action and section paths', () => {
    expect(providerPath('upstash-redis')).toBe('/reference/upstash-redis');
    expect(macroActionReferencePath('github', 'read')).toBe('/reference/github#macro-read');
    expect(sectionPath('github', 'macro-actions')).toBe('/reference/github#macro-actions');
    expect(riskAnchor('github.read-code')).toBe('risk-github.read-code');
    expect(macroActionAnchor('read')).toBe('macro-read');
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

describe('the reference of the shipped plugins', () => {
  it('has one card per plugin of the registry, in registration order', () => {
    const cards = providerCards(registry);
    expect(cards.map((card) => card.id)).toEqual([...registry.ids]);
    for (const card of cards) {
      expect(card.counts.risks).toBeGreaterThan(0);
      expect(card.counts.macro_actions).toBeGreaterThan(0);
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

  it('gives every live entry one macro-action and a line or "left out" at each cran', () => {
    for (const reference of references) {
      expect(new Set(reference.macro_actions.map((action) => action.anchor)).size).toBe(
        reference.macro_actions.length,
      );
      for (const entry of reference.risk_groups.flatMap((group) => group.entries)) {
        if (entry.deprecated) continue;
        expect(entry.macro_action, `${reference.id}/${entry.base_id}`).not.toBeNull();
        for (const cells of Object.values(entry.at_cran)) {
          expect(cells.map((cell) => cell.risk.risk_id)).toEqual(
            entry.variants.map((risk) => risk.risk_id),
          );
          for (const cell of cells) {
            if (cell.line) expect(cell.line.quota).toBeGreaterThan(0);
          }
        }
        // Prudent leaves out palier 4 and nothing else.
        for (const cell of entry.at_cran.prudent) {
          expect(cell.line === null).toBe(cell.palier === 4);
        }
      }
      // The fallback is in "Anything else", last.
      expect(reference.macro_actions.at(-1)?.id).toBe('anything-else');
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

  it('marks no tool and no risk as handing a provider token: no shipped plugin declares one', () => {
    // The GitHub App's install-token mint is gone (ADR one-place-to-authorize-services-token-first):
    // its two risks stay in the catalog, deprecated, with no tool declared for them.
    for (const reference of references) {
      expect(
        reference.tools.some((t) => t.hands_token),
        reference.id,
      ).toBe(false);
      expect(
        reference.tools.filter((t) => t.declared_risks !== null),
        reference.id,
      ).toEqual([]);
      const handed = reference.risk_groups
        .flatMap((group) => group.entries)
        .filter((entry) => entry.hands_token);
      expect(handed, reference.id).toEqual([]);
    }
    const github = referenceOf('github');
    expect(github.tools.find((t) => t.name === 'github__mint_install_token')).toBeUndefined();
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

  it('names, on each risk, its macro-action and the tools declared for it', () => {
    const github = referenceOf('github');
    const entries = github.risk_groups.flatMap((group) => group.entries);
    const byId = new Map(entries.map((entry) => [entry.base_id, entry]));
    expect(byId.get('github.read-code')?.macro_action?.id).toBe('read');
    expect(byId.get('github.uncategorized-write')?.macro_action?.id).toBe('anything-else');
    // The deprecated mint risk of the App: no macro-action, no tool.
    expect(byId.get('github.mint-install-token-push')).toMatchObject({
      declared_tools: [],
      macro_action: null,
    });
    // Force-push is costly (palier 3): it asks first until Autonome.
    expect(
      Object.values(byId.get('github.force-push')?.at_cran ?? {}).map(
        (cells) => cells[0]?.line?.gate,
      ),
    ).toEqual(['approval', 'approval', 'auto']);
    // Both ways agree: a macro-action's ids are exactly the risks that name it.
    for (const reference of references) {
      for (const action of reference.macro_actions) {
        const naming = reference.risk_groups
          .flatMap((group) => group.entries)
          .filter((entry) => entry.macro_action?.id === action.id)
          .map((entry) => entry.base_id);
        expect(new Set(naming)).toEqual(new Set(action.risk_ids));
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
