/**
 * Structural test (spec §10): "a user's authority on a connection is
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      const team = await rig.root.store.groups.getOrCreate('team', 'idp');
      teamId = team.id;
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
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
      const owners = await rig.root.store.groups.getOrCreate('owners', 'local');
      await rig.root.store.groups.addMember(owners.id, rig.ada.id);
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        owners.id,
      );
      const canShare = async () =>
        rig.root.shares.service
          .contextFor(await rig.actor(rig.bob), rig.connection.id)
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
  });
});
