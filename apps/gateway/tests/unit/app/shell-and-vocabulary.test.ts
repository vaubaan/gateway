/**
 * The navigation, the words and the routes of the interface, without a
 * browser: seven entries in a fixed order, every page under exactly one of
 * them, every old path redirected to a page that exists, the theme choice,
 * and the sentence patterns pages share.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFUSAL_CODES } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { LEGACY_REDIRECTS } from '../../../next.config';
import { isCurrentSection, sectionOf } from '../../../src/components/shell/nav';
import { activityNav } from '../../../src/components/shell/activity-nav';
import { ADMIN_PAGES, settingsNav } from '../../../src/components/shell/settings-nav';
import { nextTheme, parseTheme, themeAttribute, themeCookie } from '../../../src/lib/theme';
import {
  accessGiven,
  ACT_WORDS,
  activityLede,
  ago,
  asksFirst,
  besidesOwners,
  count,
  giveAccessLabel,
  holderWords,
  ownedBy,
  ROW_WORDS,
  REASON_WORDS,
  REFUSAL_WORDS,
  shortDate,
  stepsDone,
  GATE_WORDS,
  gateWordOf,
  keyOf,
  limitsReset,
  mayAllow,
  MISSION_STATES,
  NAV,
  NAV_ORDER,
  ownership,
  qualifiers,
  reachedLimit,
  roomLeft,
  ROUTES,
  TERMS,
  usage,
  waitingFor,
  WHY_LABELS,
  WHY_ORDER,
  whyValue,
} from '../../../src/lib/vocabulary';
import { CONNECT_CALLBACK_PATH, ACCOUNTS_PATH } from '../../../src/server/accounts/service';
import { PROVIDERS_PATH } from '../../../src/lib/providers/links';
import { INBOX_PATH } from '../../../src/server/requests/url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/app');

/** Does a page or a route answer this path? Dynamic segments are tried as `[id]` and `[provider]`. */
function served(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const roots = ['(app)', '(public)', 'admin/(guarded)', ''];
  return roots.some((root) => {
    const base = root === 'admin/(guarded)' ? segments.slice(1) : segments;
    if (root === 'admin/(guarded)' && segments[0] !== 'admin') return false;
    const dir = resolve(APP, root, ...base);
    return existsSync(resolve(dir, 'page.tsx')) || existsSync(resolve(dir, 'route.ts'));
  });
}

describe('the side navigation', () => {
  it('holds seven entries, in the order of the redesign', () => {
    expect(NAV_ORDER.map((key) => NAV[key].label)).toEqual([
      'Now',
      'Waiting for you',
      'Missions',
      'Accounts',
      'Activity',
      'Reference',
      'Settings',
    ]);
    expect(NAV_ORDER.map((key) => NAV[key].href)).toEqual([
      '/',
      '/waiting',
      '/missions',
      '/accounts',
      '/activity',
      '/reference',
      '/settings',
    ]);
  });

  it('leads every entry to a page that exists', () => {
    for (const key of NAV_ORDER) expect(served(NAV[key].href), NAV[key].href).toBe(true);
    expect(served(ROUTES.design)).toBe(true);
  });

  it('puts every page under exactly one entry', () => {
    expect(sectionOf('/')).toBe('now');
    expect(sectionOf('/waiting/abc')).toBe('waiting');
    expect(sectionOf('/missions/abc/session')).toBe('missions');
    expect(sectionOf('/missions-archive')).toBeNull();
    expect(sectionOf('/accounts/new/github')).toBe('accounts');
    expect(sectionOf('/shares')).toBe('accounts');
    expect(sectionOf('/activity')).toBe('activity');
    expect(sectionOf('/reference/github')).toBe('reference');
    for (const path of ['/settings', '/admin', '/admin/users', '/design']) {
      expect(sectionOf(path), path).toBe('settings');
    }
    expect(sectionOf('/login')).toBeNull();
  });

  it('marks a section for its own path and the paths under it', () => {
    expect(isCurrentSection('/missions', '/missions')).toBe(true);
    expect(isCurrentSection('/missions/abc/session', '/missions')).toBe(true);
    expect(isCurrentSection('/missions-archive', '/missions')).toBe(false);
    expect(isCurrentSection('/reference/github', '/missions')).toBe(false);
  });

  it('gives Settings a local navigation whose entries exist, with no label used twice', () => {
    const person = settingsNav(false);
    const administrator = settingsNav(true);
    expect(person.map((group) => group.label)).toEqual(['You']);
    expect(administrator.map((group) => group.label)).toEqual(['You', 'Administration']);
    const items = administrator.flatMap((group) => group.items);
    for (const item of items) expect(served(item.href), item.href).toBe(true);
    expect(new Set(items.map((item) => item.label)).size).toBe(items.length);
    expect(items.map((item) => item.href)).toEqual(
      expect.arrayContaining(Object.values(ADMIN_PAGES)),
    );
  });

  it('gives Activity its tabs, Record then Timeline, each a page under Activity', () => {
    const items = activityNav().flatMap((group) => group.items);
    expect(items.map((item) => item.label)).toEqual(['Record', 'Timeline']);
    for (const item of items) {
      expect(served(item.href), item.href).toBe(true);
      expect(sectionOf(item.href), item.href).toBe('activity');
    }
    // `/activity` itself is served: it leads to the first tab.
    expect(served(ROUTES.activity)).toBe(true);
  });
});

describe('the routes follow the words', () => {
  it('serves the pages under the new names, from the constants the server redirects with', () => {
    expect(ACCOUNTS_PATH).toBe(ROUTES.accounts);
    expect(INBOX_PATH).toBe(ROUTES.waiting);
    expect(PROVIDERS_PATH).toBe(ROUTES.reference);
  });

  it('redirects every old page path to a page or a route that exists', () => {
    const concrete: Readonly<Record<string, string>> = {
      ':first': 'new',
      ':rest*': 'github',
      ':path*': 'github',
      ':page': 'create',
      ':id': '[id]',
    };
    for (const { source, destination } of LEGACY_REDIRECTS) {
      // A destination may name a region of its page by a fragment.
      const target = destination
        .split('#')[0]!
        .replace(/:[a-z]+\*?/g, (param) => concrete[param] ?? 'x');
      // `/accounts/new/github`, `/reference/github`, `/waiting/<id>`…
      const probe = target.startsWith('/waiting/') ? '/waiting/[id]' : target;
      const path = probe.replace('/reference/github', '/reference/[id]');
      expect(
        served(path.replace('/accounts/new/github', '/accounts/new/[provider]')),
        `${source} → ${destination}`,
      ).toBe(true);
    }
    const sources = LEGACY_REDIRECTS.map((rule) => rule.source);
    for (const old of ['/connections', '/requests', '/audit', '/providers']) {
      expect(sources, old).toContain(old);
    }
    // The two pages that were folded into another: what a colleague gave access to is a
    // region of Accounts; connected apps were retired, their addresses lead to Settings.
    const byOld = new Map(LEGACY_REDIRECTS.map((rule) => [rule.source, rule.destination]));
    expect(byOld.get('/shares')).toBe(ROUTES.accounts);
    expect(byOld.get('/delegations/:path*')).toBe(ROUTES.settings);
    expect(byOld.get('/settings/connected-apps/:path*')).toBe(ROUTES.settings);
    expect(byOld.get('/admin/connections')).toBe(`${ROUTES.accounts}#without-owner`);
  });

  it('never redirects the callback a provider was given: it is part of the protocol', () => {
    expect(CONNECT_CALLBACK_PATH).toBe('/connections/callback');
    expect(served('/connections/callback/[provider]')).toBe(true);
    const first = LEGACY_REDIRECTS.filter((rule) => rule.source.includes(':first'));
    expect(first.length).toBe(2);
    for (const rule of first) {
      // The pattern of the first segment, as the router compiles it into the whole path.
      const pattern = rule.source.slice(
        rule.source.indexOf(':first(') + ':first('.length,
        rule.source.lastIndexOf(')'),
      );
      expect(pattern, rule.source).toBe('(?!callback(?:/|$))[^/]+');
      const whole = new RegExp(`^/connections/(${pattern})(?:/.*)?$`);
      expect(whole.test('/connections/callback')).toBe(false);
      expect(whole.test('/connections/callback/github')).toBe(false);
      expect(whole.test('/connections/new')).toBe(true);
      expect(whole.test('/connections/new/github')).toBe(true);
      expect(whole.test('/connections/callbacks')).toBe(true);
    }
    // Nothing under /api, /mcp, /r or /oauth is touched.
    for (const { source } of LEGACY_REDIRECTS) {
      expect(source).toMatch(
        /^\/(admin\/connections|connections|requests|audit|providers|shares|delegations|settings\/connected-apps|account)\b/,
      );
    }
  });
});

describe('the theme choice', () => {
  it('reads two values and treats anything else as "follow the system"', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    for (const raw of [undefined, null, '', 'system', 'DARK', 'blue']) {
      expect(parseTheme(raw)).toBe('system');
    }
    expect(themeAttribute('system')).toBeUndefined();
    expect(themeAttribute('dark')).toBe('dark');
  });

  it('cycles through the three states and comes back', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  it('remembers a choice for a year and forgets "system"', () => {
    expect(themeCookie('dark', true)).toBe(
      'vaubaan_theme=dark; Path=/; SameSite=Lax; Secure; Max-Age=31536000',
    );
    expect(themeCookie('light', false)).toBe(
      'vaubaan_theme=light; Path=/; SameSite=Lax; Max-Age=31536000',
    );
    expect(themeCookie('system', false)).toBe('vaubaan_theme=; Path=/; SameSite=Lax; Max-Age=0');
  });
});

describe('the vocabulary', () => {
  it('names each thing with one word, and keeps mission and macro-action', () => {
    expect(TERMS.account.one).toBe('account');
    expect(TERMS.risk.many).toBe('permissions');
    expect(TERMS.missionToken.one).toBe('key');
    expect(TERMS.namedToken.one).toBe('machine key');
    expect(TERMS.member.one).toBe('teammate');
    expect(TERMS.operator.one).toBe('administrator');
    expect(TERMS.mission.one).toBe('mission');
    expect(TERMS.macroAction.one).toBe('macro-action');
    expect(TERMS).not.toHaveProperty('preset');
    const words = Object.values(TERMS).map((term) => term.one);
    expect(new Set(words).size).toBe(words.length);
  });

  it('counts in words and groups thousands', () => {
    expect(count(1, TERMS.risk)).toBe('1 permission');
    expect(count(26, TERMS.risk)).toBe('26 permissions');
    expect(count(1212, TERMS.call)).toBe('1,212 calls');
    expect(usage(1860, 3000)).toBe('1,860 / 3,000');
    expect(roomLeft(49, 50)).toBe('49 of 50 left today');
    expect(limitsReset('day')).toBe('limits reset every day');
    expect(mayAllow(15, 15)).toBe('all 15');
    expect(mayAllow(12, 15)).toBe('12 of 15');
    expect(accessGiven('Bob', 12, 17)).toBe('access given by Bob · 12 of 17');
  });

  it('says the gate by what happens', () => {
    expect(GATE_WORDS[gateWordOf('auto')]).toBe('runs freely');
    expect(GATE_WORDS[gateWordOf('approval')]).toBe('ask me first');
    expect(asksFirst(null)).toBe('Asks you first');
    // A label of a narrow column: the role, not the address (the header names the creator).
    expect(asksFirst('alice@acme-demo.example')).toBe('Asks the creator first');
  });

  it('says roles and keys in sentences', () => {
    expect(qualifiers(['you', 'creator'])).toBe('· you · creator');
    expect(qualifiers([null, false, undefined])).toBe('');
    expect(ownership({ you: true })).toBe('you own it');
    expect(ownership({ you: true, team: 'Platform' })).toBe('you own it with Platform');
    expect(ownership({ you: false, name: 'Bob' })).toBe('Bob owns it');
    expect(keyOf({ name: 'Carol' })).toBe('Carol’s key');
    expect(keyOf({ name: 'Alice', you: true })).toBe('your key');
    expect(keyOf({ name: 'nightly', machine: true })).toBe('the machine key nightly');
    expect(waitingFor(null)).toBe('waiting for your yes');
    expect(waitingFor('Alice')).toBe('waiting for Alice’s yes');
    expect(waitingFor('Chris')).toBe('waiting for Chris’ yes');
    expect(reachedLimit('Nightly audit')).toBe('Nightly audit reached its daily limit');
  });

  it('colours a state only when it differs from normal', () => {
    expect(MISSION_STATES.active.tone).toBeNull();
    expect(MISSION_STATES.limitReached.tone).toBe('bad');
    expect(MISSION_STATES.waiting.tone).toBe('warn');
  });

  it('labels the five facts of the risk model in words', () => {
    expect(WHY_ORDER.map((axis) => WHY_LABELS[axis])).toEqual([
      'Undo',
      'Blast radius',
      'Data',
      'Cost',
      'Visible to',
    ]);
    expect(whyValue('blast', 'account')).toBe('whole account');
    // A value the catalog adds later is printed as it is, never dropped.
    expect(whyValue('data', 'something-new')).toBe('something-new');
  });

  it('says how long ago in the fewest characters', () => {
    const now = new Date('2026-10-13T11:02:00Z');
    expect(ago('2026-10-13T11:01:30Z', now)).toBe('now');
    expect(ago('2026-10-13T10:58:00Z', now)).toBe('4 min');
    expect(ago('2026-10-13T10:00:00Z', now)).toBe('1 h');
    expect(ago('2026-10-12T09:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-10-09T09:00:00Z', now)).toBe('4 d');
  });
});

describe('the words of the accounts, reference, activity and settings pages', () => {
  it('says who owns an account, and who else holds it', () => {
    expect(ownedBy({ team: false, name: 'Bob', you: true })).toBe('you own it');
    expect(ownedBy({ team: false, name: 'Bob', you: false })).toBe('owned by Bob');
    expect(
      ownedBy({
        team: true,
        name: 'Platform',
        you: true,
        people: [
          { name: 'Bob', you: false },
          { name: 'Alice', you: true },
        ],
      }),
    ).toBe('owned by the Platform team (Bob, you)');
    expect(ownedBy({ team: true, name: 'Platform', you: false })).toBe(
      'owned by the Platform team',
    );
    expect(besidesOwners(0)).toBe('nobody else');
    expect(besidesOwners(3)).toBe('3 besides owners');
    expect(holderWords('group GitHub admins')).toBe('the GitHub admins team');
    expect(holderWords('bob@example.com')).toBe('bob@example.com');
  });

  it('names the confirming button of "Give access" after what it gives', () => {
    expect(giveAccessLabel(10, false)).toBe('Give access · 10 permissions');
    expect(giveAccessLabel(1, true)).toBe('Update access · 1 permission');
  });

  it('writes a short date without the year when it is this year', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(shortDate('2026-09-14T08:00:00Z', now)).toBe('14 Sep');
    expect(shortDate('2025-09-02T08:00:00Z', now)).toBe('2 Sep 2025');
  });

  it('names a row and its reason, the retention of the record and the setup count', () => {
    expect(ROW_WORDS[3]).toBe('Repairable, at a price');
    expect(REASON_WORDS['personal-data']).toBe('personal data');
    expect(activityLede(90)).toBe(
      'Every call an agent made and every change a person made, kept 90 days. This is the audit record.',
    );
    expect(activityLede(1)).toContain('kept 1 day.');
    expect(stepsDone(3, 5)).toBe('3 of 5 done');
  });

  it('has a word for every refusal code and every administrative act of the protocol', () => {
    expect(Object.keys(REFUSAL_WORDS).sort()).toEqual([...REFUSAL_CODES].sort());
    for (const words of Object.values(ACT_WORDS)) expect(words.length).toBeGreaterThan(0);
    // No protocol word is printed as prose: these are the interface's own. Account is
    // both (ADR one-word-per-thing-account-service-plugin).
    for (const words of [...Object.values(REFUSAL_WORDS), ...Object.values(ACT_WORDS)]) {
      expect(words).not.toMatch(/\b(share|risk|delegation|operator|token)s?\b/);
    }
  });
});
