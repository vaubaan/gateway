/**
 * The plugin page in the C3 layout (website spec §2.3): the page data of
 * `plugin-page.ts` (the map, its reading, the spreads, the mission, the
 * connect block), the HTML the page renders from it, and its Markdown twin.
 * The HTML is rendered here as the page renders it on the server, with the
 * collector unread; `npm run build` renders the same component for every
 * plugin.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { GATE_WORDS, TRUST_LEVEL_LABELS, UNDO_ROW_WORDS, WHY_VALUES } from '@vaubaan/policy-engine';

import { PluginPageView } from '../../../src/components/plugin/PluginPage';
import { unreadSnapshot } from '../../../src/content/health';
import {
  BROKER_DOC,
  brokerAdminSentences,
  connectSentences,
  levelsSentence,
  mapOf,
  MAP_ROWS,
  missionOf,
  spreadsOf,
  type SpreadLine,
} from '../../../src/content/plugin-page';
import {
  pluginPageMarkdown,
  withHealth,
  type PluginWithHealth,
} from '../../../src/content/plugin-pages';
import { loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
import { SITE_REDIRECTS } from '../../../src/site/redirects';
import {
  parseThresholds,
  THRESHOLDS_SOURCE,
  type ValidationThresholds,
} from '../../../src/content/thresholds';

let plugins: PluginWithHealth[] = [];
let thresholds: ValidationThresholds;

beforeAll(async () => {
  thresholds = parseThresholds(readRepoFile(THRESHOLDS_SOURCE));
  plugins = withHealth(await loadPlugins(REPO_ROOT), unreadSnapshot('offline in the tests'));
}, 60_000);

function byId(id: string): PluginWithHealth {
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`no plugin '${id}'`);
  return plugin;
}

function html(id: string): string {
  return renderToStaticMarkup(<PluginPageView plugin={byId(id)} thresholds={thresholds} />);
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
    .replace(/\s+/g, ' ');
}

describe('the map', () => {
  it('has the four undo rows, worst first, named by the policy engine', () => {
    const map = mapOf(byId('github'));
    expect(map.rows.map((r) => r.word)).toEqual(MAP_ROWS.map((row) => UNDO_ROW_WORDS[row]));
    expect(map.rows[0]?.word).toBe(WHY_VALUES.reversibility.irreversible);
    expect(map.rows[3]?.word).toBe(WHY_VALUES.reversibility.reversible);
  });

  it('places each GitHub permission by macro-action and undo, tinted by its risk word', () => {
    const map = mapOf(byId('github'));
    expect(map.columns.map((c) => c.id)).toEqual([
      'read',
      'propose',
      'ship',
      'administer',
      'anything-else',
    ]);
    const cell = (row: number, column: string) =>
      map.rows.find((r) => r.row === row)?.cells[map.columns.findIndex((c) => c.id === column)] ??
      [];
    expect(cell(4, 'ship').map((b) => b.riskId)).toEqual(['github.delete-release']);
    expect(cell(2, 'read').map((b) => b.riskId)).toEqual(['github.search-global']);
    expect(cell(3, 'administer').find((b) => b.riskId.includes('workflow'))?.severity).toBe('high');
    expect(map.rows.find((r) => r.row === 2)?.sensitiveBy).toEqual([WHY_VALUES.blast.account]);
    // The fallback sits in "Anything else", dashed, and is not counted.
    const fallback = cell(3, 'anything-else');
    expect(fallback.every((b) => b.fallback)).toBe(true);
    expect(map.permissions).toBe(17);
    expect(map.permissions).toBe(byId('github').counts.permissions);
  });

  it('says in each row what the trust levels do, from the gates', () => {
    const map = mapOf(byId('github'));
    expect(map.rows.find((r) => r.row === 1)?.levelsSentence).toBe(
      `${GATE_WORDS.free} at every level`,
    );
    expect(map.rows.find((r) => r.row === 4)?.levelsSentence).toBe(
      `${GATE_WORDS.off} at ${TRUST_LEVEL_LABELS.careful}, ${GATE_WORDS.ask} at ${TRUST_LEVEL_LABELS.trusting} and ${TRUST_LEVEL_LABELS.autonomous}`,
    );
    expect(
      levelsSentence([
        { level: 'careful', label: 'A', gate: 'ask' },
        { level: 'trusting', label: 'B', gate: 'free' },
        { level: 'autonomous', label: 'C', gate: 'ask' },
      ]),
    ).toBe(`${GATE_WORDS.ask} at A and C, ${GATE_WORDS.free} at B`);
  });

  it('computes the reading sentence from its counts', () => {
    expect(mapOf(byId('github')).reading).toBe(
      `Of the 17 permissions, undo is easy for 8; easy, but sensitive for 1; costly for 7; impossible for 1. ` +
        `Careful: runs freely 8, ask me first 8, not included 1; ` +
        `Trusting: runs freely 9, ask me first 8; Autonomous: runs freely 16, ask me first 1.`,
    );
  });

  it('places an environment-scoped permission by the vector of each environment', () => {
    const supabase = byId('supabase');
    const map = mapOf(supabase);
    expect(map.envScoped).toBe(true);
    expect(map.reading).toContain('counted once per environment');
    const boxes = map.rows.flatMap((r) => r.cells.flat().map((b) => ({ ...b, row: r.row })));
    for (const box of boxes.filter((b) => b.envs.length > 0)) {
      const risk = supabase.risks.find((r) => r.id === box.riskId);
      for (const env of box.envs) {
        const variant = risk?.envVariants.find((v) => v.env === env);
        expect(variant?.acceptable, `${box.riskId}[${env}]`).toBe(true);
        expect(variant?.tier, `${box.riskId}[${env}]`).toBe(box.row);
        expect(variant?.severity, `${box.riskId}[${env}]`).toBe(box.severity);
      }
    }
  });
});

describe('the spreads', () => {
  it('follow the catalog order, one per macro-action, with its own column of the map', () => {
    const github = byId('github');
    const spreads = spreadsOf(github);
    expect(spreads.map((s) => s.id)).toEqual(github.macroActions.map((a) => a.id));
    const read = spreads[0]!;
    expect(read.column.flatMap((r) => r.cells.flat().map((b) => b.riskId)).sort()).toEqual(
      github.macroActions[0]!.entries.map((e) => e.riskId).sort(),
    );
    expect(read.levelHeadings.map((h) => h.heading)).toEqual([
      'Careful ×1 · a day',
      'Trusting ×3 · a day',
      'Autonomous ×10 · a day',
    ]);
    expect(read.limitsNote).toContain('a day unless its creator picks another');
    expect(read.limitsNote).toContain('a minute');
    // The column beside a spread says only what makes its own permissions sensitive.
    const propose = spreads[1]!;
    expect(propose.column.find((r) => r.row === 2)?.sensitiveBy).toEqual([]);
    expect(read.column.find((r) => r.row === 2)?.sensitiveBy).toEqual([WHY_VALUES.blast.account]);
  });

  it('give an environment-scoped permission one line per environment, with its own gates', () => {
    for (const id of ['railway', 'supabase']) {
      const plugin = byId(id);
      for (const [i, spread] of spreadsOf(plugin).entries()) {
        const action = plugin.macroActions[i]!;
        const expected = action.entries.flatMap(
          (e): Pick<SpreadLine, 'riskId' | 'env' | 'levels'>[] =>
            e.envLevels.length === 0
              ? [{ riskId: e.riskId, env: null, levels: e.levels }]
              : e.envLevels.map((l) => ({ riskId: e.riskId, env: l.env, levels: l.levels })),
        );
        expect(
          spread.lines.map((l) => ({ riskId: l.riskId, env: l.env, levels: l.levels })),
          `${id} ${spread.id}`,
        ).toEqual(expected);
      }
      expect(
        spreadsOf(plugin).some((s) => s.lines.some((l) => l.env !== null)),
        id,
      ).toBe(true);
    }
  });
});

describe('the mission, worked out', () => {
  it('sums up the first macro-actions at Careful in Can / Asks first / Cannot', () => {
    const mission = missionOf(byId('github'));
    expect(mission.groups.map((g) => g.items.length)).toEqual([8, 3, 0]);
    expect(mission.nothingRuns).toBe(false);
    expect(mission.notTicked).toContain('Ship and Administer');
  });

  it('says so when Careful leaves everything out (Context7)', () => {
    const mission = missionOf(byId('context7'));
    expect(mission.nothingRuns).toBe(true);
    expect(mission.groups.find((g) => g.key === 'cannot')?.items.length).toBeGreaterThan(0);
    expect(mission.intro).toContain('can do nothing');
  });
});

describe('connecting an account, in three shapes', () => {
  it('a pasted key: the token, created at the service and pasted', () => {
    const github = byId('github');
    const [sentence] = connectSentences(github.credentials[0]!, github.name);
    expect(github.credentials[0]?.clientSource).toBe('pasted-key');
    expect(sentence).toMatch(/token .*pastes once/);
  });

  it('a client the gateway registers (Miro)', () => {
    const miro = byId('miro');
    expect(connectSentences(miro.credentials[0]!, miro.name).join(' ')).toContain(
      'registers its own client',
    );
  });

  it('a broker’s client, never described as a client the gateway registers', () => {
    for (const id of ['google-calendar', 'outlook']) {
      const plugin = byId(id);
      const c = plugin.credentials[0]!;
      expect(c.clientSource, id).toBe('broker');
      const all = [
        ...brokerAdminSentences(c, plugin.name),
        ...connectSentences(c, plugin.name),
      ].join(' ');
      expect(all).toContain(`\`${c.brokerProvider}\``);
      expect(all).toContain('enrolled with an OAuth broker');
      expect(all).toContain('attested');
      expect(all).toContain('someone else operates');
      expect(all).toContain('your own client');
      expect(all).not.toMatch(/regist/);
    }
  });
});

describe('the rendered page', () => {
  it('never says "tier", in the HTML or the Markdown twin, for any plugin', () => {
    for (const plugin of plugins) {
      expect(html(plugin.id), plugin.id).not.toMatch(/\btiers?\b/i);
      expect(pluginPageMarkdown(plugin, thresholds), plugin.id).not.toMatch(/\btiers?\b/i);
    }
  });

  it('/plugins/github: the eight sections in order, the map with its 17 permissions, a token pasted', () => {
    const page = html('github');
    const order = ['map', 'do-read', 'do-propose', 'do-ship', 'do-administer', 'examples'];
    const rest = ['anything-else', 'mission', 'connect', 'retired', 'tools', 'health', 'links'];
    const at = [...order, ...rest].map((id) => page.indexOf(`<section id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    const map = section(page, 'map');
    expect(map).toContain('<table class="map">');
    const ids = new Set(
      [...map.matchAll(/<li class="perm[^"]*" data-risk-id="([^"]+)"/g)].map((m) => m[1]),
    );
    ids.delete('github.uncategorized-write');
    expect(ids.size).toBe(17);
    expect(map).toContain('perm-fallback');
    expect(map).toMatch(/perm perm-high[^>]*data-risk-id="github.workflow-write-via-file"/);

    const connect = words(section(page, 'connect'));
    expect(section(page, 'connect')).toContain('data-client-source="pasted-key"');
    expect(connect).toMatch(/token/);
    expect(connect).toMatch(/pastes once/);
    expect(words(page)).toContain('What an agent does in GitHub, in 4 macro-actions');
  });

  it('/plugins/google-calendar: the connect block names the broker, the provider, the scopes and the two sources', () => {
    const calendar = byId('google-calendar');
    const raw = section(html('google-calendar'), 'connect');
    const connect = words(raw);
    expect(raw).toContain('data-client-source="broker"');
    expect(connect).toContain('OAuth broker');
    expect(connect).toContain('google');
    for (const scope of calendar.credentials[0]!.scopes) expect(connect).toContain(scope);
    expect(connect).toContain('enrol with a broker someone else operates');
    expect(connect).toContain('run the published broker image with your own client');
    expect(raw).toContain(`href="${BROKER_DOC}"`);
    expect(connect).not.toMatch(/regist/);
  });

  it('shows the gate marks and the six facts with the one that moves the gate tinted', () => {
    const ship = section(html('github'), 'do-ship');
    expect(ship).toContain('data-gate="off"');
    expect(ship).toContain('data-gate="ask"');
    expect(ship).toMatch(/class="cell cell-moves"[^>]*><dt>Undo<\/dt>/);
    const read = section(html('github'), 'do-read');
    expect(read).toMatch(/class="cell cell-moves"[^>]*><dt>Blast radius<\/dt>/);
  });
});

describe('the Markdown twin', () => {
  it('keeps the order of the page, the map as a list by undo row', () => {
    const md = pluginPageMarkdown(byId('github'), thresholds);
    const headings = [...md.matchAll(/^##+ (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'The map',
      'Read',
      'Propose',
      'Ship',
      'Administer',
      'Worked examples',
      'Anything else',
      'A mission, worked out',
      'Connecting an account',
      'Retired permissions',
      'Tools',
      'Health',
      'Links',
    ]);
    const map = md.slice(md.indexOf('## The map'), md.indexOf('### Read'));
    const rows = [...map.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]?.toLowerCase());
    expect(rows).toEqual(MAP_ROWS.map((row) => UNDO_ROW_WORDS[row]));
    expect(map).toContain('`github.delete-release`');
  });

  it('names the broker and its provider for Google Calendar', () => {
    const md = pluginPageMarkdown(byId('google-calendar'), thresholds);
    const connect = md.slice(md.indexOf('## Connecting an account'), md.indexOf('## Tools'));
    expect(connect).toContain('`google`');
    expect(connect).toContain(`](${BROKER_DOC})`);
  });
});

describe('section 7, the connect guide inline', () => {
  it('opens with the kind badge, one of three, for every way', () => {
    const badge = (id: string) =>
      /class="connect-badge">([^<]*)</.exec(section(html(id), 'connect'))?.[1];
    expect(badge('github')).toBe('1 of 3 · a key you create and paste');
    expect(badge('ssh')).toBe('1 of 3 · a key you create and paste');
    expect(badge('miro')).toBe('2 of 3 · you sign in and allow the gateway (its own client)');
    expect(badge('google-calendar')).toBe('3 of 3 · you sign in through an OAuth broker');
  });

  it('a brokered service starts with the administrator’s block, before what the person does', () => {
    const connect = section(html('google-calendar'), 'connect');
    expect(connect).toContain('class="connect-admin"');
    expect(connect).toContain('Before anyone connects');
    expect(connect.indexOf('connect-admin')).toBeLessThan(
      connect.indexOf('signs in through the client'),
    );
    expect(connect).toContain(`href="${BROKER_DOC}"`);
    expect(section(html('miro'), 'connect')).not.toContain('connect-admin');
  });

  it('draws each step’s menu path as chips before the sentence', () => {
    const connect = section(html('github'), 'connect');
    const chips = [...connect.matchAll(/class="path-seg">([^<]*)</g)].map((m) => m[1]);
    expect(chips).toEqual(expect.arrayContaining(['Settings', 'Developer settings']));
    expect(connect).toContain('aria-label="Where to click at GitHub"');
    expect(connect).not.toContain('<figure');
  });

  it('shows the screenshot of the hard screen with its provenance line', () => {
    const connect = section(html('cloudflare-dns'), 'connect');
    const figures = [...connect.matchAll(/<figure class="shot">(.*?)<\/figure>/g)].map(
      (m) => m[1] ?? '',
    );
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatch(
      /<img src="\/plugins\/cloudflare-dns\/connect\/create-token\.webp" alt="[^"]+" loading="lazy"\/>/,
    );
    expect(figures[0]).toContain(
      '<figcaption>Cloudflare DNS docs, 2026-11 · from developers.cloudflare.com (CC BY 4.0)</figcaption>',
    );
  });

  it('has no page of its own: the old address redirects to the section', () => {
    expect(section(html('github'), 'connect')).not.toContain('/docs/providers/');
    expect(SITE_REDIRECTS).toContainEqual({
      source: '/docs/providers/:id([a-z][a-z0-9-]*)',
      destination: '/plugins/:id#connect',
      permanent: true,
    });
  });
});
