/**
 * Structural test (spec §10): "a user's authority on an account is
 * recomputed from their current group membership, never from a snapshot."
 *
 * Two halves. Statically, the authority module keeps nothing between two
 * questions: its classes hold their dependencies and no other state, and
 * they reach neither a cache nor the web session (whose `login.groups` is
 * the claim list of the last sign-in, kept for display). Behaviourally, one
 * long-lived instance is asked the same question around membership changes
 * made straight in the store, at the three places an authority is used:
 * issuance, the Share dialog's owner check, and the execution door.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORED_MISSION_STATUSES } from '../../../src/server/store/repositories/enums';
import { authorityRig, READ, type AuthorityRig } from '../../integration/authority/support';

const AUTHORITY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/server/authority');
const SOURCES = readdirSync(AUTHORITY)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(AUTHORITY, name), 'utf8') }));

describe('authority is recomputed, never snapshotted', () => {
  describe('the authority module keeps no state', () => {
    it('finds the module', () => {
      expect(SOURCES.map((s) => s.name)).toEqual(
        expect.arrayContaining(['authority-service.ts', 'mission-grounds.ts', 'membership.ts']),
      );
    });

    it.each(SOURCES)(
      '$name: its classes hold their dependencies and nothing else',
      ({ name, text }) => {
        const source = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
        const state: string[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isClassDeclaration(node)) {
            for (const member of node.members) {
              // A field is state. The only one allowed is the `deps` constructor parameter.
              if (ts.isPropertyDeclaration(member)) {
                state.push(`${node.name?.text}.${member.name.getText(source)}`);
              }
              if (ts.isConstructorDeclaration(member)) {
                for (const parameter of member.parameters) {
                  const isField = (ts.getModifiers(parameter) ?? []).length > 0;
                  if (isField && parameter.name.getText(source) !== 'deps') {
                    state.push(`${node.name?.text}.${parameter.name.getText(source)}`);
                  }
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(state).toEqual([]);
      },
    );

    it.each(SOURCES)('$name: reaches no cache and no web session', ({ text }) => {
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/cache|session|compose\/ports|\/auth\b/i);
      }
      // No module-level memo either.
      expect(text).not.toMatch(/^(?:const|let) \w+ = new (?:Map|Set|WeakMap)\b/m);
      expect(text).not.toMatch(/CacheClient|login\.groups/);
    });
  });

  describe('one long-lived instance, membership changed in the store between two questions', () => {
    let rig: AuthorityRig;
    let teamId: string;

    beforeEach(async () => {
      rig = await authorityRig();
      const team = await rig.root.store.groups.getOrCreate('team', 'idp', 'idp');
      teamId = team.id;
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
        target: { kind: 'group', groupId: teamId },
        riskIds: [READ],
      });
    });
    afterEach(async () => {
      await rig.close();
    });

    const join_ = () => rig.root.store.groups.addMember(teamId, rig.bob.id);
    const leave = () => rig.root.store.groups.removeMember(teamId, rig.bob.id);
    const held = async () =>
      (await rig.root.missions.service.issuanceContext(rig.bob)).flatMap((c) => c.authority);

    it('issuance follows the membership on the very next question', async () => {
      expect(await held()).toEqual([]);
      await join_();
      expect(await held()).toEqual([READ]);
      await leave();
      expect(await held()).toEqual([]);
      expect((await rig.tryIssue(rig.bob, [READ])).ok).toBe(false);
      await join_();
      expect((await rig.tryIssue(rig.bob, [READ])).ok).toBe(true);
    });

    it('the web session of the last sign-in does not keep an authority alive', async () => {
      await join_();
      // The session remembers the claims of the sign-in: the group is still listed there.
      const session = await rig.root.auth.sessions.create({
        kind: 'user',
        userId: rig.bob.id,
        login: { email: rig.bob.email, groups: ['team'] },
      });
      const headers = new Headers({ cookie: session.setCookie.split(';')[0] ?? '' });
      const groupsNow = async () => {
        const principal = await rig.root.auth.authenticator.authenticate(headers);
        return principal?.kind === 'user' ? principal.groups.map((g) => g.name) : null;
      };
      expect(await groupsNow()).toEqual(['team']);
      await leave();
      expect(await groupsNow()).toEqual([]);
      expect(await held()).toEqual([]);
    });

    it('ownership through a group follows the membership too', async () => {
      const owners = await rig.root.store.groups.getOrCreate('owners', 'local', null);
      await rig.root.store.groups.addMember(owners.id, rig.ada.id);
      await rig.root.accounts.service.transfer(await rig.actor(rig.ada), rig.account.id, owners.id);
      const canShare = async () =>
        rig.root.shares.service
          .contextFor(await rig.actor(rig.bob), rig.account.id)
          .then(() => true)
          .catch(() => false);
      expect(await canShare()).toBe(false);
      await rig.root.store.groups.addMember(owners.id, rig.bob.id);
      expect(await canShare()).toBe(true);
      await rig.root.store.groups.removeMember(owners.id, rig.bob.id);
      expect(await canShare()).toBe(false);
    });

    it('the execution door re-reads the creator’s authority on every request', async () => {
      await join_();
      const mission = await rig.issueFor(rig.bob, [READ]);
      expect((await rig.read(mission)).result).toBeDefined();
      expect((await rig.read(mission)).result).toBeDefined();
      await leave();
      expect((await rig.read(mission)).error?.data).toMatchObject({
        code: 'mission-inactive',
        status: 'orphaned',
      });
    });

    it('`orphaned` itself is no snapshot: the verdict follows the membership in both directions and is written nowhere', async () => {
      await join_();
      const mission = await rig.issueFor(rig.bob, [READ]);
      expect((await rig.read(mission)).result).toBeDefined();
      const row = () =>
        rig.root.store.db
          .prepare<[string], { status: string; updated_at: string; closed_at: string | null }>(
            'SELECT status, updated_at, closed_at FROM missions WHERE id = ?',
          )
          .get(mission.mission.id);
      const asIssued = row();
      expect(asIssued).toMatchObject({ status: 'active', closed_at: null });

      for (let round = 0; round < 3; round += 1) {
        await leave();
        expect((await rig.read(mission)).error?.data).toMatchObject({ status: 'orphaned' });
        expect(await rig.statusOf(mission)).toBe('orphaned');
        expect(row()).toEqual(asIssued);

        await join_();
        expect((await rig.read(mission)).result).toBeDefined();
        expect(await rig.statusOf(mission)).toBe('active');
        expect(row()).toEqual(asIssued);
      }
      // Seven calls allowed, three refused; the refused ones consumed nothing.
      const missionLog = await rig.root.store.missionLogs.getByMission(mission.mission.id);
      const counters = await rig.root.store.missionLogs.counters(missionLog?.id ?? '');
      expect(counters.map((c) => c.consumed)).toEqual([4]);
    });
  });

  describe('no stored orphan verdict (spec §2.3 "never stored as a verdict")', () => {
    const SERVER = resolve(AUTHORITY, '..');
    const MIGRATIONS = resolve(SERVER, '../../migrations');
    const SKIPPED = /\.test\.tsx?$|\/testing\.ts$/;

    function productionSources(dir: string): { path: string; text: string }[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return productionSources(path);
        if (!/\.tsx?$/.test(entry.name) || SKIPPED.test(path)) return [];
        return [{ path: relative(SERVER, path), text: readFileSync(path, 'utf8') }];
      });
    }
    const PRODUCTION = productionSources(SERVER);

    it('no production source writes the status', () => {
      expect(PRODUCTION.length).toBeGreaterThan(100);
      const writers = PRODUCTION.filter(
        ({ text }) =>
          /markOrphaned/.test(text) ||
          /status\s*=\s*'orphaned'[^;]*\bWHERE\b/i.test(text) ||
          /SET\s+status\s*=\s*'orphaned'/i.test(text) ||
          /setStatus\([^)]*'orphaned'/.test(text),
      ).map((s) => s.path);
      expect(writers).toEqual([]);
    });

    it('the repository cannot store it: neither its type, nor its parser, nor the table', async () => {
      expect(STORED_MISSION_STATUSES).not.toContain('orphaned');
      const rig = await authorityRig();
      try {
        const { db } = rig.root.store;
        const triggers = db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'missions' ORDER BY name",
          )
          .all()
          .map((t) => t.name);
        expect(triggers).toEqual([
          'missions_orphaned_not_stored_insert',
          'missions_orphaned_not_stored_update',
        ]);
        const mission = await rig.issueFor(rig.ada, [READ]);
        expect(() =>
          db
            .prepare("UPDATE missions SET status = 'orphaned' WHERE id = ?")
            .run(mission.mission.id),
        ).toThrow(/never stored/);
      } finally {
        await rig.close();
      }
    });

    it('the last migration that mentions the value is the one that removes it', () => {
      const mentioning = readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .filter((name) => /'orphaned'/.test(readFileSync(join(MIGRATIONS, name), 'utf8')));
      expect(mentioning).toEqual(['0001_schema.sql', '0007_orphaned_not_stored.sql']);
    });

    /**
     * Every production file that loads a mission record from the repository. A
     * record carries the *stored* status, which is `active` for an orphaned
     * mission: a reader that shows or decides on the status must derive it first.
     * A new reader fails this test until it is classified here.
     */
    const MISSION_READERS: Readonly<Record<string, string>> = {
      'authority/mission-grounds.ts': 'is the derivation: lists the missions it checks',
      'missions/mission-service.ts':
        'derives: `access`, `ownInspected` and `list` go through `grounds.inspect`; `verifyToken` hands the record to the door, which derives',
      'missions/mission-edits.ts':
        "reads the name only, of the mission that authored a version (the history's words); the mission edited comes from the service's `ownMission`, which derives; never the status",
      'missions/token-issuer.ts':
        'reads a token row by prefix only to know whether a drawn prefix is free; the mission that comes with it is never looked at',
      'requests/request-service.ts':
        'derives: `own` goes through `grounds.derive`; the inbox reads the name only',
      'compose/root.ts':
        'derives: `missionsOnService` (the activation page’s missions of a service) goes through `grounds.derive` before reading the status',
      'execution/admission.ts':
        'derives: `grounds.inspect` on every request of both doors (MCP and the remote), before the pipeline',
      'audit/query-service.ts': 'reads names and creators only, never the status',
      'audit/timeline.ts':
        'reads the name and the creator only, to name an event’s mission and say whose answer a request waits for; never the status',
      'notifications/dispatch.ts':
        'reads the name and the creator only, to address and word a notification; never the status',
      'budget/budget-stage.ts':
        'reads the period anchor only; the status it decides on is the context’s, derived by the door',
      'budget/retention.ts':
        'reads the period anchor and length only, to know which period is the current one',
      'accounts/discovery.ts':
        'reads the creator and the accounts of a mission only, to authorize "check now" (`checkForMission`); never the status: a discovery of an account is the owner’s act whatever the mission’s state',
      'import-v4/importer.ts':
        'reads the names of the owner’s missions and the stored `revoked` only, to recognise what an earlier import issued; an orphaned mission is still that mission and is not issued twice',
    };
    const LOADS =
      /missions\s*\.\s*(?:getById|listForCreator|listForMember|listForAccount|findTokenByPrefix)\b/;
    const DERIVES = /grounds\s*\.\s*(?:inspect|derive)\b/;

    it('every reader of a mission record derives the state or does not read it', () => {
      const readers = PRODUCTION.filter(
        ({ path, text }) => LOADS.test(text) && !path.startsWith('store/'),
      ).map((s) => s.path);
      // The admission loads through the token verifier; it is listed for what it does next.
      expect([...readers, 'execution/admission.ts'].sort()).toEqual(
        Object.keys(MISSION_READERS).sort(),
      );

      const text = (path: string) => PRODUCTION.find((s) => s.path === path)?.text ?? '';
      for (const [path, why] of Object.entries(MISSION_READERS)) {
        if (!why.startsWith('derives')) continue;
        expect(
          DERIVES.test(text(path)),
          `${path} must call grounds.inspect or grounds.derive`,
        ).toBe(true);
      }
    });

    it('the readers that do not derive really do not read the status', () => {
      const text = (path: string) => PRODUCTION.find((s) => s.path === path)?.text ?? '';
      for (const path of [
        'audit/query-service.ts',
        'notifications/dispatch.ts',
        'budget/budget-stage.ts',
        'budget/retention.ts',
        'missions/token-issuer.ts',
        'missions/mission-edits.ts',
        'accounts/discovery.ts',
      ]) {
        // `record.status`, `mission.status`, `m.status`: none on a loaded record (the
        // pipeline context `ctx.mission.status` is the door's derived one).
        expect(text(path), path).not.toMatch(/(?<!\.)\b(?:record|mission|m)\.status\b/);
      }
    });
  });
});
