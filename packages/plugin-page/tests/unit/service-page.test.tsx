/**
 * The page of a service (website spec §2.3, gateway spec §4.2), as
 * `@vaubaan/plugin-page` builds and draws it for both apps: the page data
 * (the model, the map and its toggles, the calls, the connect guide) and the
 * HTML `ServicePage` renders from it, sections 1–8, the anchors the gateway's
 * pages link to, and what an app hands in. Every plugin of the repository is
 * loaded as the gateway loads it (`load.ts`); the site's own sections and its
 * Markdown twin are tested in `apps/website`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  GATE_WORDS,
  REASON_WORDS,
  reasonOf,
  ROW_GATE_SENTENCES,
  ROW_WORDS,
  rowOf,
  TREE_LEGEND,
  TRUST_LEVEL_HINTS,
} from '@vaubaan/policy-engine';
import { serviceMarkColors } from '@vaubaan/shared/service-mark';

import { pluginInfo, type PluginInfo, type ServicePageContext } from '../../src/info';
import { discoverPluginDirs, importPlugin } from '../../src/load';
import { ServiceMark } from '../../src/marks';
import {
  BROKER_DOC,
  brokerAdminSentences,
  callsOf,
  connectSentences,
  ENV_TOGGLE_MAX,
  isResourceEntity,
  MAP_ROWS,
  mapOf,
  modelOf,
  summaryParts,
  toggleEnvsOf,
} from '../../src/page-data';
import { ServicePage, type ServicePageProps } from '../../src/ServicePage';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTEXT: ServicePageContext = {
  figureSrc: (id, file) => `/shots/${id}/${file}`,
};

let plugins: PluginInfo[] = [];

beforeAll(async () => {
  const loaded = await Promise.all(
    discoverPluginDirs(REPO_ROOT).map(async (dir) => {
      const plugin = await importPlugin(REPO_ROOT, dir);
      return pluginInfo(plugin, { ...CONTEXT, dir, examplesSource: `${dir}/src/examples.ts` });
    }),
  );
  plugins = loaded.sort((a, b) => a.id.localeCompare(b.id));
}, 60_000);

function byId(id: string): PluginInfo {
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`no plugin '${id}'`);
  return plugin;
}

function render(props: ServicePageProps): string {
  return renderToStaticMarkup(<ServicePage {...props} />);
}

const pages = new Map<string, string>();
function html(id: string): string {
  const known = pages.get(id);
  if (known) return known;
  const page = render({ plugin: byId(id), sourceHref: (path) => `source:${path}` });
  pages.set(id, page);
  return page;
}

/** The HTML of one section of the page, by its id. */
function section(page: string, id: string): string {
  const start = page.indexOf(`<section id="${id}"`);
  if (start < 0) throw new Error(`no section '${id}'`);
  return page.slice(start, page.indexOf('</section>', start));
}

/** Text without tags, entities decoded: what a reader sees. */
function words(fragment: string): string {
  return fragment
    .replace(/<wbr\/?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

describe('the page, in eight sections', () => {
  it('draws every section in order, numbered, retired before connecting, and nothing of an app', () => {
    const page = html('github');
    const ids = [
      'model',
      'macro-actions',
      'map',
      'examples',
      'anything-else',
      'tools',
      'retired',
      'connect',
    ];
    const at = ids.map((id) => page.indexOf(`<section id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const kickers = [...page.matchAll(/<p class="pp-k">(\d+) · ([^<]+)<\/p>/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(kickers).toEqual([
      '1 The model',
      '2 Macro-actions',
      '3 The map',
      '4 A few calls',
      '5 Anything else',
      '6 Tools',
      '7 Retired permissions',
      '8 Connecting an account',
    ]);
    expect(page).not.toContain('<section id="health"');
    expect(page).not.toContain('vaubaan.com');
    expect(page).not.toContain('github.com/vaubaan');
  });

  it('the header: mark, name, version, description and the counts line', () => {
    const github = byId('github');
    const hero = html('github').slice(0, html('github').indexOf('<section'));
    expect(hero).toContain('class="pp-svc"');
    expect(words(hero)).toContain(`GitHub ${github.version}`);
    expect(words(hero)).toContain(github.description);
    expect(words(hero)).toMatch(/18 permissions · 4 macro-actions · \d+ tools and the git remote/);
  });

  it('never says "tier" nor "severity", for any plugin', () => {
    for (const plugin of plugins) {
      const page = words(html(plugin.id));
      expect(page, plugin.id).not.toMatch(/\btiers?\b/i);
      expect(page, plugin.id).not.toMatch(/\bseverity\b/i);
    }
  });
});

describe('what an app hands the page', () => {
  it('numbers its own sections after connecting, and puts its crumbs, aside, meta and foot in place', () => {
    const page = render({
      plugin: byId('github'),
      crumbs: <a href="/list">List</a>,
      titleAside: <span id="aside">(i)</span>,
      meta: ['3 gateways'],
      sections: [
        { id: 'health', kicker: 'Health', title: 'Health', body: <p>fine</p> },
        { id: 'links', kicker: 'Links', title: 'Links', body: <p>here</p> },
      ],
      footer: <p id="foot">foot</p>,
    });
    expect(page).toContain('<p class="crumbs"><a href="/list">List</a></p>');
    expect(page).toMatch(/<\/h1><span id="aside">/);
    expect(words(page)).toMatch(/and the git remote · 3 gateways/);
    expect(page).toContain('<p class="pp-k">9 · Health</p>');
    expect(page).toContain('<p class="pp-k">10 · Links</p>');
    expect(page.indexOf('id="foot"')).toBeGreaterThan(page.indexOf('<section id="links"'));
  });

  it('puts the name one level down under an app’s own title, and the sections with it', () => {
    const page = render({ plugin: byId('supabase'), titleLevel: 2 });
    expect(page).not.toMatch(/<h1[ >]/);
    expect(page).toMatch(/<h2[^>]*>Supabase <span class="version">/);
    expect(page).toContain('<h3 id="map-title">The map</h3>');
    expect(page).toMatch(/<h4>[^<]*Account[^<]*<\/h4>/);
  });

  it('sends every link of the page through the app: the documentation and the source', () => {
    const resolved = render({
      plugin: byId('google-calendar'),
      href: (path) => `https://docs.example${path}`,
    });
    expect(resolved).toContain(`href="https://docs.example${BROKER_DOC}"`);
    expect(resolved).not.toContain(`href="${BROKER_DOC}"`);
    const github = render({ plugin: byId('github'), href: (path) => `docs:${path}` });
    expect(section(github, 'tools')).toContain('href="docs:/docs/missions/git-remote"');
    // Without a source address, the examples' file is not linked.
    expect(section(github, 'examples')).not.toContain('examples.ts"');
  });

  it('serves the connect guide’s screenshots where the app says', () => {
    const connect = section(html('cloudflare-dns'), 'connect');
    expect(connect).toMatch(/<img src="\/shots\/cloudflare-dns\/[^"]+"/);
  });
});

describe('the anchors other pages link to', () => {
  it('gives every permission one #risk-<id> and every macro-action one #macro-<id>', () => {
    for (const plugin of plugins) {
      const page = html(plugin.id);
      const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
      for (const risk of plugin.risks) {
        expect(
          ids.filter((id) => id === `risk-${risk.id}`),
          `${plugin.id}: ${risk.id}`,
        ).toHaveLength(1);
      }
      for (const action of plugin.macroActions) {
        expect(
          ids.filter((id) => id === `macro-${action.id}`),
          `${plugin.id}: ${action.id}`,
        ).toHaveLength(1);
      }
      expect(new Set(ids).size, `${plugin.id}: ids are unique`).toBe(ids.length);
    }
  });

  it('puts a permission’s anchor on a chip shown before anyone toggles', () => {
    const page = section(html('supabase'), 'map');
    const anchored = /<li id="risk-supabase.bulk-row-write" class="([^"]*)"/.exec(page)?.[1];
    expect(anchored).toBeDefined();
    // The chip of every environment, or of the first one (prod).
    expect(anchored === 'pp-ch' || /\be-0\b/.test(anchored!)).toBe(true);
  });
});

describe('1 · the model', () => {
  it('draws the planes and entities of the data model, the resource highlighted', () => {
    const github = byId('github');
    const model = section(html('github'), 'model');
    expect(words(model)).toContain('1 plane, 23 things.');
    for (const entity of github.dataModel.planes.flatMap((p) => p.entities)) {
      expect(model, entity.name).toContain(`${entity.name}`);
    }
    expect(model).toMatch(/class="pp-bx res[^"]*"><div class="pp-hd"><b>repo<\/b>/);
    expect(model).toContain('<span class="pp-lbl">Resource</span>');
    // search is a root beside the resource, not inside it.
    expect(model).toMatch(
      /<div class="pp-root"><div class="pp-bx[^"]*"><div class="pp-hd"><b>search<\/b>/,
    );
    // GitHub's branch carries the environment in the model only: dashed outline, no tag.
    expect(model).toMatch(/class="pp-bx envlike[^"]*"><div class="pp-hd"><b>branch<\/b>/);
    expect(words(model)).toContain('carries the environment, in the model only');
  });

  it('marks cardinalities, dashes what no tool touches, and keeps each description behind an (i)', () => {
    const github = byId('github');
    const model = section(html('github'), 'model');
    expect(model).toContain('<i>1</i><i>n</i><i>*</i>');
    const untouched = github.dataModel.planes.flatMap((p) => p.entities).filter((e) => !e.touched);
    expect(untouched.length).toBeGreaterThan(0);
    for (const e of untouched)
      expect(model).toMatch(new RegExp(`ghost[^"]*">(<div class="pp-hd"><b>)?${e.name}`));
    expect(words(model)).toContain('no tool touches it');
    const tips = [...model.matchAll(/class="pp-tip" role="tooltip">/g)];
    expect(tips.length).toBe(github.dataModel.planes.reduce((n, p) => n + p.entities.length, 0));
  });

  it('gives the Account, Resource and Environment callouts from the summary and the catalog', () => {
    const supabase = modelOf(byId('supabase'));
    expect(supabase.account).toMatch(/^One account is one personal access token/);
    expect(supabase.resource).toMatch(/^One resource is one project/);
    expect(supabase.environmentNotes.join(' ')).toContain('one project per environment');
    expect(supabase.envs).toEqual(['preview', 'staging', 'prod']);
    const model = words(section(html('supabase'), 'model'));
    expect(model).toContain(
      'The environment is the label the owner of the account puts on each resource',
    );
    expect(model).toContain('db.project');
    expect(words(section(html('vercel'), 'model'))).toContain(
      'The environment is read from each call',
    );
  });

  it('cuts a summary in account, resource and environment sentences', () => {
    expect(
      summaryParts(
        'One account is a key; one resource is a box. It has no environment. It is fine.',
      ),
    ).toEqual({
      account: 'One account is a key.',
      resource: 'One resource is a box. It is fine.',
      environment: ['It has no environment.'],
    });
    expect(summaryParts(null)).toEqual({ account: null, resource: null, environment: [] });
  });

  it('finds the resource entity from the resource noun', () => {
    expect(isResourceEntity('repo', { one: 'repository', other: 'repositories' })).toBe(true);
    expect(isResourceEntity('index', { one: 'library index', other: 'library indexes' })).toBe(
      true,
    );
    expect(isResourceEntity('library', { one: 'library index', other: 'library indexes' })).toBe(
      false,
    );
    expect(isResourceEntity('page', { one: 'page or database', other: 'pages or databases' })).toBe(
      true,
    );
    expect(isResourceEntity('repo-settings', { one: 'repository', other: 'repositories' })).toBe(
      false,
    );
    expect(isResourceEntity('repo', null)).toBe(false);
    for (const plugin of plugins.filter((p) => p.resourceNoun)) {
      const found = plugin.dataModel.planes.some((p) =>
        p.entities.some((e) => isResourceEntity(e.name, plugin.resourceNoun)),
      );
      expect(found, plugin.id).toBe(true);
    }
  });
});

describe('2 · macro-actions', () => {
  it('one card per macro-action in catalog order: number, label, description, narrative, count', () => {
    const github = byId('github');
    const cards = [
      ...section(html('github'), 'macro-actions').matchAll(
        /<li id="macro-[^"]+" class="pp-vc" data-macro-action="([^"]+)">(.*?)<\/li>/g,
      ),
    ];
    expect(cards.map((m) => m[1])).toEqual(github.macroActions.map((a) => a.id));
    github.macroActions.forEach((action, i) => {
      const card = words(cards[i]![2]!);
      expect(card).toContain(`${i + 1} ${action.label}`);
      expect(card).toContain(action.description);
      expect(card).toContain(`${action.entries.length} permission`);
    });
  });
});

describe('3 · the map', () => {
  it('has the four rows, worst first, named and explained by the policy engine', () => {
    const map = mapOf(byId('github'));
    expect(map.rows.map((r) => r.word)).toEqual(MAP_ROWS.map((row) => ROW_WORDS[row]));
    expect(map.rows.map((r) => r.gates)).toEqual(MAP_ROWS.map((row) => ROW_GATE_SENTENCES[row]));
    const page = section(html('github'), 'map');
    expect(words(page)).toContain(TREE_LEGEND);
    expect(page.indexOf('Cannot be repaired')).toBeLessThan(page.indexOf('>Harmless<'));
  });

  it('places each permission by macro-action and row, with its reason word', () => {
    const github = byId('github');
    const map = mapOf(github);
    const ids = new Set(map.rows.flatMap((r) => r.cells.flat().map((c) => c.riskId)));
    expect(ids.size).toBe(18);
    expect(ids.has('github.uncategorized-write')).toBe(false);
    for (const row of map.rows) {
      for (const chip of row.cells.flat()) {
        const risk = github.risks.find((r) => r.id === chip.riskId)!;
        expect(chip.row).toBe(rowOf(risk.vector));
        expect(chip.rowReason).toBe(reasonOf(risk.vector));
      }
    }
    const page = section(html('github'), 'map');
    expect(page).toContain(`<span class="pp-why"> ${REASON_WORDS['whole-account']}</span>`);
  });

  it('holds the three trust levels in the DOM, Careful checked, with ×1 ×3 ×10 quotas', () => {
    const page = section(html('github'), 'map');
    expect(page).toContain(
      '<input class="sr" type="radio" id="lvl-c" name="trust-level" checked=""/>',
    );
    expect(page).toContain('<input class="sr" type="radio" id="lvl-t" name="trust-level"/>');
    expect(page).toContain('<input class="sr" type="radio" id="lvl-a" name="trust-level"/>');
    for (const key of ['c', 't', 'a']) expect(page).toContain(`label for="lvl-${key}"`);
    const entry = byId('github').macroActions[0]!.entries.find(
      (e) => e.riskId === 'github.read-code',
    )!;
    const chip = /<li [^>]*class="pp-ch"[^>]*data-risk-id="github.read-code"[^>]*>(.*?)<\/li>/.exec(
      page,
    )![1]!;
    const day = (n: number) => n.toLocaleString('en-US');
    const yes = '<b class="pp-g g-free" data-gate="free">yes</b>';
    expect(chip).toContain(`class="q l-c">${yes} · ${day(entry.quota)} a day`);
    expect(chip).toContain(`class="q l-t">${yes} · ${day(entry.quota * 3)} a day`);
    expect(chip).toContain(`class="q l-a">${yes} · ${day(entry.quota * 10)} a day`);
    for (const level of Object.values(TRUST_LEVEL_HINTS)) expect(words(page)).toContain(level);
    for (const word of Object.values(GATE_WORDS)) expect(words(page)).toContain(word);
  });

  it('draws the environment toggle only when the data model carries an environment the catalog names', () => {
    expect(section(html('github'), 'map')).not.toContain('name="map-env"');
    expect(toggleEnvsOf(byId('github'))).toEqual([]);
    expect(toggleEnvsOf(byId('supabase'))).toEqual(['prod', 'staging', 'preview']);
    const page = section(html('supabase'), 'map');
    expect(page).toContain('id="env-0" name="map-env" checked=""');
    expect(words(page)).toContain('Environment prod staging preview');
    for (const plugin of plugins) {
      expect(toggleEnvsOf(plugin).length, plugin.id).toBeLessThanOrEqual(ENV_TOGGLE_MAX);
      const toggled = section(html(plugin.id), 'map').includes('name="map-env"');
      expect(toggled, plugin.id).toBe(
        plugin.environment.carriers.length > 0 && plugin.environment.envs.length > 0,
      );
    }
  });

  it('takes an env-qualified permission’s vector per environment, and says "never on" where refused', () => {
    const supabase = byId('supabase');
    const map = mapOf(supabase);
    const chips = map.rows.flatMap((r) => r.cells.flat());
    const bulk = chips.filter((c) => c.riskId === 'supabase.bulk-row-write');
    const refused = bulk.find((c) => c.refused)!;
    expect(refused.envs).toEqual(['prod']);
    expect(refused.values.every((v) => v.never && v.gate === 'off')).toBe(true);
    for (const chip of chips.filter((c) => !c.refused)) {
      const risk = supabase.risks.find((r) => r.id === chip.riskId)!;
      for (const env of chip.envs ?? []) {
        const variant = risk.envVariants.find((v) => v.env === env)!;
        expect(variant.row, `${chip.riskId}[${env}]`).toBe(chip.row);
      }
    }
    const page = section(html('supabase'), 'map');
    expect(page).toMatch(
      /<li [^>]*class="pp-ch eo pref e-0"[^>]*data-risk-id="supabase.bulk-row-write"/,
    );
    expect(words(page)).toContain('no · never on prod');
  });

  it('sums each level (per environment) and keeps the fallback out of the map', () => {
    const github = mapOf(byId('github'));
    expect(github.sums.map((s) => s.text)).toEqual([
      expect.stringMatching(/^Careful: runs freely \d+, ask me first \d+(, not included \d+)?\.$/),
      expect.stringMatching(/^Trusting: /),
      expect.stringMatching(/^Autonomous: /),
    ]);
    const supabase = mapOf(byId('supabase'));
    expect(supabase.sums).toHaveLength(9);
    expect(supabase.sums[0]!.text).toMatch(/^Careful on prod: /);
    expect(supabase.notes.join(' ')).toContain('Not accepted on prod:');
  });
});

describe('4 · a few calls', () => {
  it('one per macro-action whose permissions all belong to it, then the first refused at Careful', () => {
    const github = byId('github');
    const calls = callsOf(github);
    expect(calls.total).toBe(github.examples.length);
    const refused = calls.rows.filter((e) => e.atCareful.outcome === 'cannot');
    expect(refused.length).toBeGreaterThanOrEqual(1);
    const own = calls.rows.filter((e) => e.atCareful.outcome !== 'cannot');
    for (const e of own) {
      expect(
        github.macroActions.some((a) =>
          e.permissions.every((id) => a.entries.some((x) => x.riskId === id)),
        ),
      ).toBe(true);
    }
    const page = section(html('github'), 'examples');
    expect(words(page)).toContain(`${github.examples.length} declared calls`);
    expect(page).toContain('href="source:plugins/github/src/examples.ts"');
  });
});

describe('5–7 · anything else, tools, retired', () => {
  it('Anything else: the fallback with its row, reason and three gates; the tools left out', () => {
    const page = section(html('github'), 'anything-else');
    expect(page).toContain('data-risk-id="github.uncategorized-write"');
    expect(page).toMatch(/class="pp-rowtag r-\d"/);
    expect(page.match(/data-level=/g)).toHaveLength(3);
    expect(words(page)).toContain('Left out on purpose');
  });

  it('Tools: a scrolling, focusable, labelled box with a sticky header', () => {
    const github = byId('github');
    const page = section(html('github'), 'tools');
    expect(words(page)).toContain(`${github.tools.length} tools · scroll the list`);
    expect(page).toContain(
      `class="pp-tscroll" role="region" aria-label="${github.tools.length} tools" tabindex="0"`,
    );
    expect(words(page)).toContain('git remote');
  });
});

describe('8 · connecting an account', () => {
  it('opens with the kind badge, one of three, for every way', () => {
    const badge = (id: string) =>
      /class="connect-badge">([^<]*)</.exec(section(html(id), 'connect'))?.[1];
    expect(badge('github')).toBe('1 of 3 · a key you create and paste');
    expect(badge('ssh')).toBe('1 of 3 · a key you create and paste');
    expect(badge('miro')).toBe('2 of 3 · you sign in and allow the gateway (its own client)');
    expect(badge('google-calendar')).toBe('3 of 3 · you sign in through an OAuth broker');
  });

  it('a pasted key: the intro, the reach box headed by what it is, the grants without a "For" column', () => {
    const github = byId('github');
    const c = github.credentials[0]!;
    expect(connectSentences(c, 'GitHub')).toEqual([
      `A ${c.label} the person creates at GitHub and pastes once; nobody declares anything beforehand.`,
    ]);
    const page = section(html('github'), 'connect');
    expect(page).toContain(`<div class="pp-reach"><b>${c.reach!.what}</b>`);
    expect(words(page)).toContain('Permission at GitHub Access');
    expect(page).not.toMatch(/<th scope="col">For<\/th>/);
    expect(words(page)).not.toMatch(/\bfor github__/);
    expect(page).toMatch(/<dt>Where<\/dt>.*<dt>Expiry<\/dt>.*<dt>The connect page asks<\/dt>/);
    expect(page).toContain('<dt>Disconnecting</dt>');
  });

  it('alternatives: a CSS-only toggle, first checked, each panel its own steps then the shared ones', () => {
    const vercel = byId('vercel');
    const c = vercel.credentials[0]!;
    const page = section(html('vercel'), 'connect');
    expect(page).toContain('id="alt-0" name="key-shape" checked=""');
    expect(page).toContain('id="alt-1" name="key-shape"/>');
    expect(words(page)).toContain(`Choose one ${c.alternatives.map((a) => a.label).join(' ')}`);
    const panels = [...page.matchAll(/<div class="pp-altpanel alt-(\d)"[^>]*>(.*?)<\/ol><\/div>/g)];
    expect(panels).toHaveLength(c.alternatives.length);
    panels.forEach((m, i) => {
      const alt = c.alternatives[i]!;
      const steps = [...m[2]!.matchAll(/<span class="step-do">([^<]*)<\/span>/g)].map((s) => s[1]);
      expect(steps).toEqual([...alt.steps, ...c.steps].map((s) => s.do.replace(/'/g, '&#x27;')));
    });
    expect(section(html('github'), 'connect')).not.toContain('key-shape');
  });

  it('draws each step’s menu path as chips, and the screenshot with its provenance line', () => {
    const connect = section(html('github'), 'connect');
    const chips = [...connect.matchAll(/class="path-seg">([^<]*)</g)].map((m) => m[1]);
    expect(chips).toEqual(expect.arrayContaining(['Settings', 'Developer settings']));
    expect(connect).toContain('aria-label="Where to click at GitHub"');
    const cloudflare = section(html('cloudflare-dns'), 'connect');
    const figures = [...cloudflare.matchAll(/<figure class="shot">(.*?)<\/figure>/g)];
    expect(figures).toHaveLength(1);
    expect(figures[0]![1]).toContain(
      '<figcaption>Cloudflare DNS docs, 2026-11 · from developers.cloudflare.com (CC BY 4.0)</figcaption>',
    );
  });

  it('a brokered service starts with the administrator’s block and is never a registered client', () => {
    for (const id of ['google-calendar', 'outlook']) {
      const plugin = byId(id);
      const c = plugin.credentials[0]!;
      expect(c.clientSource, id).toBe('broker');
      const all = [
        ...brokerAdminSentences(c, plugin.name),
        ...connectSentences(c, plugin.name),
      ].join(' ');
      expect(all).toContain(`\`${c.brokerProvider}\``);
      expect(all).toContain('attested');
      expect(all).not.toMatch(/regist/);
    }
    const connect = section(html('google-calendar'), 'connect');
    expect(connect).toContain('Before anyone connects');
    expect(connect.indexOf('connect-admin')).toBeLessThan(
      connect.indexOf('signs in through the client'),
    );
    expect(connect).toContain(`href="${BROKER_DOC}"`);
    for (const scope of byId('google-calendar').credentials[0]!.scopes) {
      expect(words(connect)).toContain(scope);
    }
    expect(section(html('miro'), 'connect')).not.toContain('connect-admin');
    expect(words(section(html('miro'), 'connect'))).toContain('registers its own client');
  });
});

describe('ServiceMark', () => {
  const PATH = 'M0 0h24v24H0z';

  it('draws the path in the brand colour, the dark theme by the shared rule', () => {
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color="#635BFF" />);
    expect(html).toContain(`d="${PATH}"`);
    expect(html).toContain('--mark-color:#635BFF');
    expect(html).toContain('--mark-color-dark:#635BFF');
  });

  it('hands a near-black brand to the ink in the dark theme', () => {
    expect(serviceMarkColors('#181717').dark).toBeNull();
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color="#181717" />);
    expect(html).toContain('--mark-color:#181717');
    expect(html).toContain('--mark-color-dark:var(--ink)');
  });

  it('keeps the ink without a colour, and has a small size for lists', () => {
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color={null} size="sm" />);
    expect(html).not.toContain('--mark-color');
    expect(html).toContain('class="pp-svc pp-svc-sm"');
    expect(html).toContain('width="16"');
  });
});

describe('the style sheet', () => {
  const css = readFileSync(join(REPO_ROOT, 'packages/plugin-page/src/plugin-page.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('declares no colour: every value is a --pp-* property an app maps to its tokens', () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
    const vars = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    for (const name of vars) {
      expect(name.startsWith('--pp-') || name.startsWith('--mark-color'), name).toBe(true);
    }
  });

  it('scopes every rule under .plugin-page, so nothing leaks into the app around it', () => {
    const selectors = [...rules.matchAll(/(?:^|[{};])\s*([^{}@;]+)\{/g)]
      .map((m) => m[1]!.trim())
      // Split at the commas between selectors, not those inside `:is(…)`.
      .flatMap((s) => s.split(/,(?![^(]*\))/))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(selectors.length).toBeGreaterThan(100);
    const scoped =
      /^(:root:not\(\[data-theme='light'\]\) |:root\[data-theme='dark'\] )?\.plugin-page\b/;
    for (const selector of selectors) expect(selector, selector).toMatch(scoped);
  });

  it('writes the toggles for every environment and alternative a plugin may need', () => {
    for (let i = 0; i < ENV_TOGGLE_MAX; i += 1) expect(css).toContain(`#env-${i}:checked`);
    for (let i = 0; i < 4; i += 1) expect(css).toContain(`#alt-${i}:checked`);
  });
});
