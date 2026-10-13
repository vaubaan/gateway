/**
 * Structural test (spec §8 "one entry … per administrative act"; plan P1.8
 * "every admin mutation path writes an admin audit entry — the test
 * enumerates the service methods").
 *
 * The public methods of every class under `server/{connections,
 * provider-apps,missions,auth,requests,telemetry,authority,shares,groups,oauth-as,management}` are
 * read from the source with the TypeScript
 * parser and each must be classified below as a read, a mutation or an
 * exemption with its reason. A method added tomorrow fails the first test
 * until it is classified; a mutation is then driven on an ephemeral instance
 * and must leave the administrative entry named next to it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdminAct, AdminObjectType } from '@vaubaan/gateway-core';
import { createRegistry } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { budgetMissionOf } from '../../../src/server/budget';
import { completeLogin } from '../../../src/server/auth/login';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import type { Actor } from '../../../src/server/connections';
import {
  API_KEY_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  stateOf,
  UNVERIFIED_APP_INSTALL_SPEC,
} from '../../../src/server/connections/testing';
import { silentLogger } from '../../../src/server/logging';
import type { ManagementActor } from '../../../src/server/management';
import type { TokenResponse } from '../../../src/server/oauth-as';
import { pkcePair } from '../../../src/server/oauth-as/testing';
import type {
  ConnectionRecord,
  GroupRecord,
  MissionRecord,
  OAuthClientRecord,
  UserRecord,
} from '../../../src/server/store/types';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/server');
const SCANNED = [
  'connections',
  'provider-apps',
  'missions',
  'auth',
  'requests',
  'telemetry',
  'authority',
  'shares',
  'groups',
  'oauth-as',
  'management',
];
const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR_EMAIL = 'ops@example.com';
const OAUTH_REDIRECT = 'http://127.0.0.1:43210/callback';

// ── The enumeration: public methods of every class, from the source ─────────

const SKIPPED_FILE = /\.test\.ts$|\/testing\.ts$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !SKIPPED_FILE.test(path) ? [path] : [];
  });
}

function isHidden(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return modifiers.some(
    (m) =>
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword ||
      m.kind === ts.SyntaxKind.StaticKeyword,
  );
}

/** `Class.method` for every public instance method declared under the scanned directories. */
function publicMethods(): string[] {
  const found: string[] = [];
  for (const dir of SCANNED) {
    for (const file of sourceFiles(join(SERVER, dir))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022);
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node.name) {
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member) || isHidden(member)) continue;
            if (ts.isPrivateIdentifier(member.name)) continue;
            found.push(`${node.name.text}.${member.name.getText(source)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found.sort();
}

// ── The rig: a real root over fixture plugins and a mocked provider ─────────

interface Rig {
  readonly root: GatewayRoot;
  readonly operator: UserRecord;
  readonly alice: Actor;
  /** Same-origin form POST carrying the operator's session. */
  operatorPost(path: string, fields: Record<string, string>): Promise<Request>;
  connectByKey(): Promise<ConnectionRecord>;
  registerOAuthApp(): Promise<void>;
  issue(): Promise<MissionRecord>;
  /** An open claim on a mission of Alice whose risk has consumed one action. */
  claim(): Promise<string>;
  /** An open approval request on a mission of Alice: a call refused on a risk she gated. */
  approvalRequest(): Promise<string>;
  /** A user who signed in once: the target of a share, a member to add. */
  bob(): Promise<UserRecord>;
  /**
   * A mission of Alice on a connection owned by a local group she belongs to: her
   * authority there is that membership, which a test removes or returns.
   */
  groupGrounded(): Promise<{ mission: MissionRecord; group: GroupRecord }>;
  /** A connection of Alice, transferred to a local group that then lost its only member. */
  ownerless(): Promise<ConnectionRecord>;
  /** An OAuth client of the management door, redirecting to `redirectUri`. */
  oauthClient(redirectUri?: string): Promise<OAuthClientRecord>;
  /** A consent screen shown to Alice for `client`, not answered yet. */
  consent(client: OAuthClientRecord): Promise<{ consentId: string; verifier: string }>;
  /** A delegation of Alice to a fresh client, with its first tokens. */
  delegation(): Promise<{ client: OAuthClientRecord; id: string; tokens: TokenResponse }>;
}

async function openRig(): Promise<Rig> {
  const provider = mockFetch([
    {
      method: 'POST',
      url: OAUTH_SPEC.tokenUrl,
      body: { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 },
    },
  ]);
  const root = await buildRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL }),
      }),
    logWrite: () => undefined,
    buildRegistry: async () =>
      createRegistry([
        fixturePlugin({
          id: 'keyco',
          credential: API_KEY_SPEC,
          discoverResources: async () => [
            { provider: 'keyco', ref: 'acct-a', displayName: 'Account A' },
          ],
        }),
        fixturePlugin({ id: 'oauthco', credential: OAUTH_SPEC }),
        fixturePlugin({ id: 'oldappco', credential: UNVERIFIED_APP_INSTALL_SPEC }),
      ]),
    providerFetch: provider,
    ...memoryStoreDeps,
  });
  const operator = await root.store.users.upsertFromIdp({
    subject: 'idp|ops',
    email: OPERATOR_EMAIL,
  });
  const aliceUser = await root.store.users.upsertFromIdp({
    subject: 'idp|alice',
    email: 'alice@example.com',
  });
  const alice: Actor = { user: aliceUser, groups: [] };

  const rig: Rig = {
    root,
    operator,
    alice,
    async operatorPost(path, fields) {
      const session = await root.auth.sessions.create({
        kind: 'user',
        userId: operator.id,
        login: { email: operator.email, groups: [] },
      });
      return new Request(`${PUBLIC_URL}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: PUBLIC_URL,
          cookie: `${SESSION_COOKIE}=${session.id}`,
        },
        body: new URLSearchParams(fields).toString(),
      });
    },
    async connectByKey() {
      const started = await root.connections.service.start(alice, 'keyco', {
        displayName: 'Key account',
        fields: { token: 'key-0123456789', team_id: 'team_abc' },
      });
      if (started.kind !== 'connected') throw new Error('expected an immediate connection');
      return started.connection;
    },
    async registerOAuthApp() {
      await root.providerApps.save('oauthco', { client_id: 'cid', client_secret: 'csecret' });
    },
    async issue() {
      const connection = await rig.connectByKey();
      const result = await root.missions.service.issue(alice.user, {
        name: 'Read the things',
        connections: [{ connection_id: connection.id, preset: 'reader' }],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
      return result.mission;
    },
    async claim() {
      const mission = await rig.issue();
      const riskId = mission.policy[0]?.riskId;
      if (!riskId) throw new Error('expected a policy');
      const decided = await root.store.sessions.decideAndDecrement(
        { missionId: mission.id, riskIds: [riskId], periodStart: mission.periodAnchor },
        () => ({ allow: true }),
      );
      const request = await root.store.requests.create({
        missionId: mission.id,
        sessionId: decided.session.id,
        kind: 'claim',
        riskId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return request.id;
    },
    async approvalRequest() {
      const mission = await rig.issue();
      const riskId = mission.policy[0]?.riskId;
      if (!riskId) throw new Error('expected a policy');
      await root.missions.service.setGate(alice.user, mission.id, riskId, 'approval');
      const gated = await root.store.missions.getById(mission.id);
      if (!gated) throw new Error('the mission vanished');
      // The refusal the execution door would answer: it drops the request.
      const refused = await root.budget.recordCall({
        mission: budgetMissionOf(gated),
        tool: 'keyco__read_things',
        args: { account: 'acct-a' },
        risks_touched: [riskId],
        now: new Date(),
      });
      if (refused.outcome !== 'refused' || !refused.request_id) {
        throw new Error('expected an approval request');
      }
      return refused.request_id;
    },
    bob() {
      return root.store.users.upsertFromIdp({ subject: 'idp|bob', email: 'bob@example.com' });
    },
    async groupGrounded() {
      const mission = await rig.issue();
      const [carried] = mission.connections;
      if (!carried) throw new Error('expected a connection');
      const group = await root.store.groups.getOrCreate('mission-owners', 'local');
      await root.store.groups.addMember(group.id, aliceUser.id);
      await root.store.connections.transferOwner(carried.connectionId, {
        kind: 'group',
        id: group.id,
      });
      return { mission, group };
    },
    async ownerless() {
      const connection = await rig.connectByKey();
      const group = await root.store.groups.getOrCreate('key-admins', 'local');
      await root.store.groups.addMember(group.id, aliceUser.id);
      await root.store.connections.transferOwner(connection.id, { kind: 'group', id: group.id });
      await root.store.groups.removeMember(group.id, aliceUser.id);
      const [unowned] = await root.store.connections.markOwnerlessUnowned();
      if (!unowned) throw new Error('expected the connection to lose its owner');
      return unowned;
    },
    async oauthClient(redirectUri = OAUTH_REDIRECT) {
      const registered = await root.oauth.clients.register({
        client_name: 'Test agent',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      });
      return registered.client;
    },
    async consent(client) {
      const pkce = pkcePair();
      const consentId = await root.oauth.authorization.createPending(alice.user, {
        client,
        redirectUri: client.redirectUris[0] ?? OAUTH_REDIRECT,
        state: null,
        codeChallenge: pkce.challenge,
      });
      return { consentId, verifier: pkce.verifier };
    },
    async delegation() {
      const client = await rig.oauthClient();
      const { consentId, verifier } = await rig.consent(client);
      const outcome = await root.oauth.authorization.decide(alice.user, consentId, 'approve');
      if (outcome.outcome !== 'redirect' || !outcome.delegationId) {
        throw new Error('expected the consent to be granted');
      }
      const code = new URL(outcome.location).searchParams.get('code') ?? '';
      const tokens = await root.oauth.tokens.exchangeCode(
        client,
        new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
      );
      return { client, id: outcome.delegationId, tokens };
    },
  };
  return rig;
}

// ── The classification ──────────────────────────────────────────────────────

interface ExpectedEntry {
  readonly act: AdminAct;
  readonly object: AdminObjectType;
  /** `object.id`, when it is not the id of something the driver creates. */
  readonly objectId?: string;
  /** Who the entry names: the acting user. */
  readonly actor: 'alice' | 'operator';
  /**
   * The act comes from the management surface: the entry also names the
   * delegated client (spec §8). Absent: the entry names none.
   */
  readonly delegated?: true;
}

type Rule =
  | { readonly kind: 'read' }
  | { readonly kind: 'exempt'; readonly why: string }
  | {
      readonly kind: 'mutation';
      /** The instance whose method the driver must end up calling. */
      readonly target: (root: GatewayRoot) => object;
      /** Setup that is not the act under test (its own entries are not counted). */
      readonly prepare?: (rig: Rig) => Promise<unknown>;
      readonly drive: (rig: Rig, prepared: never) => Promise<unknown>;
      readonly writes: ExpectedEntry;
    };

const READ: Rule = { kind: 'read' };
const exempt = (why: string): Rule => ({ kind: 'exempt', why });

const SESSION_STATE =
  'web session and transient per-session state (sign-in, notices, pending flows): not an administrative act of spec §8';
const SYSTEM_REFRESH =
  'performed by the gateway during a call or a discovery, with no human actor: an administrative entry always names a user (spec §8); the outcome is in the call entry and the instance log';

const OAUTH_PROTOCOL =
  'performed by an OAuth client at a protocol endpoint, with no human actor: registering a client or exchanging a code grants nothing a user did not already consent to (`delegation-granted`); a replayed code or refresh token revokes the delegation and writes `delegation-revoked` (src/server/oauth-as/token-service.test.ts)';

const connections = (root: GatewayRoot) => root.connections.service;
const missions = (root: GatewayRoot) => root.missions.service;
const providerApps = (root: GatewayRoot) => root.providerApps;
const managementTools = (root: GatewayRoot) => root.management.tools;

/** Alice's delegation to a fresh client, as the management door hands it to its tools. */
async function delegatedActor(rig: Rig): Promise<ManagementActor> {
  const held = await rig.delegation();
  return { userId: rig.alice.user.id, delegationId: held.id, clientId: held.client.clientId };
}

const RULES: Readonly<Record<string, Rule>> = {
  // ── connections ───────────────────────────────────────────────────────────
  'ConnectionService.providers': READ,
  'ConnectionService.provider': READ,
  'ConnectionService.listFor': READ,
  'ConnectionService.get': READ,
  'ConnectionService.callbackUrl': READ,
  'ConnectionService.start': {
    kind: 'mutation',
    target: connections,
    drive: (rig) => rig.connectByKey(),
    writes: { act: 'connection-created', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.complete': {
    kind: 'mutation',
    target: connections,
    prepare: async (rig) => {
      await rig.registerOAuthApp();
      const started = await rig.root.connections.service.start(rig.alice, 'oauthco');
      if (started.kind !== 'redirect') throw new Error('expected a redirect');
      return stateOf(started.url);
    },
    drive: (rig, state: string) =>
      rig.root.connections.service.complete(
        rig.alice,
        'oauthco',
        new URLSearchParams({ code: 'code-1', state }),
      ),
    writes: { act: 'connection-created', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.discover': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.connections.service.discover(rig.alice, connection.id),
    writes: { act: 'resources-discovered', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.updateResource': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.connectByKey(),
    drive: async (rig, connection: ConnectionRecord) => {
      const [resource] = await rig.root.store.connections.listResources(connection.id);
      if (!resource) throw new Error('expected a discovered resource');
      return rig.root.connections.service.updateResource(rig.alice, connection.id, resource.id, {
        displayName: 'Renamed',
        env: 'prod',
        hidden: true,
      });
    },
    writes: { act: 'resource-edited', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.revoke': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.connections.service.revoke(rig.alice, connection.id),
    writes: { act: 'connection-revoked', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.transferTargets': READ,
  'ConnectionService.listOwnerless': READ,
  'ConnectionService.transfer': {
    kind: 'mutation',
    target: connections,
    prepare: async (rig) => {
      const connection = await rig.connectByKey();
      const group = await rig.root.store.groups.getOrCreate('key-admins', 'local');
      await rig.root.store.groups.addMember(group.id, rig.alice.user.id);
      return { connection, group };
    },
    drive: (rig, prepared: { connection: ConnectionRecord; group: GroupRecord }) =>
      rig.root.connections.service.transfer(
        { user: rig.alice.user, groups: [prepared.group] },
        prepared.connection.id,
        prepared.group.id,
      ),
    writes: { act: 'connection-transferred', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.reassign': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.ownerless(),
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.connections.service.reassign(rig.operator.id, connection.id, {
        kind: 'user',
        email: rig.alice.user.email,
      }),
    writes: { act: 'connection-reassigned', object: 'connection', actor: 'operator' },
  },
  'CredentialBroker.resolve': READ,
  'CredentialBroker.contextOf': READ,
  'CredentialBroker.oauthClient': READ,
  'CredentialBroker.refresh': exempt(SYSTEM_REFRESH),
  'PendingConnectStore.create': exempt(SESSION_STATE),
  'PendingConnectStore.take': exempt(SESSION_STATE),
  'NoticeStore.put': exempt(SESSION_STATE),
  'NoticeStore.take': exempt(SESSION_STATE),

  // ── provider apps (the entry is written by the Administration handler) ────
  'ProviderAppsService.isReadOnly': READ,
  'ProviderAppsService.list': READ,
  'ProviderAppsService.status': READ,
  'ProviderAppsService.installVerification': READ,
  'ProviderAppsService.hostAppConfig': READ,
  'ProviderAppsService.pluginAppConfig': READ,
  'ProviderAppsService.save': {
    kind: 'mutation',
    target: providerApps,
    drive: async (rig) =>
      rig.root.connections.handlers.saveProviderApp(
        await rig.operatorPost('/admin/provider-apps/oauthco', {
          'field.client_id': 'cid',
          'field.client_secret': 'csecret',
        }),
        'oauthco',
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'provider-app:oauthco',
      actor: 'operator',
    },
  },
  'ProviderAppsService.clear': {
    kind: 'mutation',
    target: providerApps,
    prepare: (rig) => rig.registerOAuthApp(),
    drive: async (rig) =>
      rig.root.connections.handlers.saveProviderApp(
        await rig.operatorPost('/admin/provider-apps/oauthco', { action: 'clear' }),
        'oauthco',
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'provider-app:oauthco',
      actor: 'operator',
    },
  },
  'ProviderAppsService.setAcceptUnverifiedInstallations': {
    kind: 'mutation',
    target: providerApps,
    drive: async (rig) =>
      rig.root.connections.handlers.saveProviderApp(
        await rig.operatorPost('/admin/provider-apps/oldappco', { action: 'accept-unverified' }),
        'oldappco',
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'provider-app:oldappco',
      actor: 'operator',
    },
  },

  // ── missions ──────────────────────────────────────────────────────────────
  'MissionService.issuanceContext': READ,
  'MissionService.preview': READ,
  'MissionService.draftFrom': READ,
  'MissionService.verifyToken': READ,
  'MissionService.list': READ,
  'MissionService.get': READ,
  'MissionService.issue': {
    kind: 'mutation',
    target: missions,
    // The connection is made first so that its own entry is not the one counted.
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.missions.service.issue(rig.alice.user, {
        name: 'Read the things',
        connections: [{ connection_id: connection.id, preset: 'reader' }],
        period: { kind: 'one-off' },
        expires_at: null,
      }),
    writes: { act: 'mission-issued', object: 'mission', actor: 'alice' },
  },
  'MissionService.duplicate': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.duplicate(rig.alice.user, mission.id),
    writes: { act: 'mission-issued', object: 'mission', actor: 'alice' },
  },
  'MissionService.rotate': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.rotate(rig.alice.user, mission.id),
    writes: { act: 'mission-rotated', object: 'mission', actor: 'alice' },
  },
  'MissionService.revoke': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.revoke(rig.alice.user, mission.id),
    writes: { act: 'mission-revoked', object: 'mission', actor: 'alice' },
  },

  'MissionService.setGate': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.setGate(
        rig.alice.user,
        mission.id,
        mission.policy[0]?.riskId ?? '',
        'approval',
      ),
    writes: { act: 'gate-changed', object: 'mission', actor: 'alice' },
  },

  // ── authority ─────────────────────────────────────────────────────────────
  'ConnectionAuthorityService.authorityOf': READ,
  'ConnectionAuthorityService.connectionsOf': READ,
  'ConnectionAuthorityService.gapsOf': READ,
  'MissionGrounds.check': READ,
  // `orphaned` is derived on every read and never stored (spec §2.3): the door's own
  // detection (`inspect`) and every reader's (`derive`) write nothing at all, in either
  // direction. Only a watch around a human act writes, and it names that human.
  'MissionGrounds.inspect': READ,
  'MissionGrounds.derive': READ,
  'MissionGrounds.watchConnection': {
    kind: 'mutation',
    target: (root) => root.authority.grounds,
    prepare: (rig) => rig.issue(),
    // The act: the connection is revoked. Loss of authority → `mission-orphaned`.
    drive: async (rig, mission: MissionRecord) => {
      const connectionId = mission.connections[0]?.connectionId ?? '';
      const watch = await rig.root.authority.grounds.watchConnection(connectionId);
      await rig.root.store.connections.revoke(connectionId);
      await watch.settle(rig.alice.user.id);
    },
    writes: { act: 'mission-orphaned', object: 'mission', actor: 'alice' },
  },
  'MissionGrounds.watchCreator': {
    kind: 'mutation',
    target: (root) => root.authority.grounds,
    prepare: (rig) => rig.groupGrounded(),
    // The act: the operator removes the creator from the group that grounded the mission.
    drive: async (rig, { group }: { group: GroupRecord }) => {
      const watch = await rig.root.authority.grounds.watchCreator(rig.alice.user.id);
      await rig.root.store.groups.removeMember(group.id, rig.alice.user.id);
      await watch.settle(rig.operator.id);
    },
    writes: { act: 'mission-orphaned', object: 'mission', actor: 'operator' },
  },
  'MembershipSettler.watch': {
    kind: 'mutation',
    target: (root) => root.authority.membership,
    // The mission is orphaned first, behind the services' back…
    prepare: async (rig) => {
      const grounded = await rig.groupGrounded();
      await rig.root.store.groups.removeMember(grounded.group.id, rig.alice.user.id);
      return grounded;
    },
    // …and the act returns the membership. Authority back → `mission-restored`.
    drive: async (rig, { group }: { group: GroupRecord }) => {
      const watch = await rig.root.authority.membership.watch(rig.alice.user.id);
      await rig.root.store.groups.addMember(group.id, rig.alice.user.id);
      await watch.settle(rig.operator.id);
    },
    writes: { act: 'mission-restored', object: 'mission', actor: 'operator' },
  },

  // ── shares ────────────────────────────────────────────────────────────────
  'ShareService.contextFor': READ,
  'ShareService.received': READ,
  'ShareService.share': {
    kind: 'mutation',
    target: (root) => root.shares.service,
    prepare: async (rig) => {
      await rig.bob();
      return rig.connectByKey();
    },
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.shares.service.share(rig.alice, connection.id, {
        target: { kind: 'user', email: 'bob@example.com' },
        riskIds: ['keyco.read-things'],
      }),
    writes: { act: 'share-created', object: 'share', actor: 'alice' },
  },
  'ShareService.revoke': {
    kind: 'mutation',
    target: (root) => root.shares.service,
    prepare: async (rig) => {
      await rig.bob();
      const connection = await rig.connectByKey();
      const { share } = await rig.root.shares.service.share(rig.alice, connection.id, {
        target: { kind: 'user', email: 'bob@example.com' },
        riskIds: ['keyco.read-things'],
      });
      return share.id;
    },
    drive: (rig, shareId: string) => rig.root.shares.service.revoke(rig.alice, shareId),
    writes: { act: 'share-revoked', object: 'share', actor: 'alice' },
  },

  // ── local groups (the caller authorizes: operator only) ───────────────────
  'GroupService.list': READ,
  'GroupService.create': {
    kind: 'mutation',
    target: (root) => root.groups.service,
    drive: (rig) => rig.root.groups.service.create(rig.operator.id, 'platform'),
    writes: { act: 'group-created', object: 'group', actor: 'operator' },
  },
  'GroupService.addMember': {
    kind: 'mutation',
    target: (root) => root.groups.service,
    prepare: (rig) => rig.root.groups.service.create(rig.operator.id, 'platform'),
    drive: (rig, group: GroupRecord) =>
      rig.root.groups.service.addMember(rig.operator.id, group.id, rig.alice.user.email),
    writes: { act: 'group-member-added', object: 'group', actor: 'operator' },
  },
  'GroupService.removeMember': {
    kind: 'mutation',
    target: (root) => root.groups.service,
    prepare: async (rig) => {
      const group = await rig.root.groups.service.create(rig.operator.id, 'platform');
      await rig.root.groups.service.addMember(rig.operator.id, group.id, rig.alice.user.email);
      return group;
    },
    drive: (rig, group: GroupRecord) =>
      rig.root.groups.service.removeMember(rig.operator.id, group.id, rig.alice.user.id),
    writes: { act: 'group-member-removed', object: 'group', actor: 'operator' },
  },

  // ── requests ──────────────────────────────────────────────────────────────
  'RequestService.inbox': READ,
  'RequestService.openCount': READ,
  'RequestService.view': READ,
  'RequestService.decide': {
    kind: 'mutation',
    target: (root) => root.requests.service,
    prepare: (rig) => rig.claim(),
    drive: (rig, requestId: string) =>
      rig.root.requests.service.decide(rig.alice.user, requestId, { resolution: 'refuse' }),
    writes: { act: 'request-refused', object: 'request', actor: 'alice' },
  },
  'RequestService.decideClaim': {
    kind: 'mutation',
    target: (root) => root.requests.service,
    prepare: (rig) => rig.claim(),
    drive: (rig, requestId: string) =>
      rig.root.requests.service.decideClaim(rig.alice.user, requestId, {
        resolution: 'reset-period',
      }),
    writes: { act: 'period-reset', object: 'request', actor: 'alice' },
  },
  'RequestService.decideApproval': {
    kind: 'mutation',
    target: (root) => root.requests.service,
    prepare: (rig) => rig.approvalRequest(),
    drive: (rig, requestId: string) =>
      rig.root.requests.service.decideApproval(rig.alice.user, requestId, {
        resolution: 'grant',
      }),
    writes: { act: 'approval-granted', object: 'request', actor: 'alice' },
  },
  'RequestService.sweep': exempt(
    'expiry of unanswered requests by the instance timer, with no human actor: an administrative entry always names a user (spec §8)',
  ),

  // ── auth ──────────────────────────────────────────────────────────────────
  'IdpSettingsService.current': READ,
  'IdpSettingsService.stored': READ,
  'IdpSettingsService.save': {
    kind: 'mutation',
    target: (root) => root.auth.idp,
    drive: async (rig) =>
      rig.root.auth.handlers.saveIdpSettings(
        await rig.operatorPost('/api/admin/identity-provider', {
          issuer: 'https://idp.example.com',
          client_id: 'gateway',
          client_secret: 'idp-client-secret',
          claim_sub: 'sub',
          claim_email: 'email',
          claim_groups: 'groups',
          allowed_email_domains: 'example.com',
        }),
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'idp',
      actor: 'operator',
    },
  },
  'BootstrapService.state': READ,
  'BootstrapService.verify': READ,
  'BootstrapService.revoke': {
    kind: 'mutation',
    target: (root) => root.auth.bootstrap,
    // The first operator sign-in revokes the bootstrap token (`completeLogin`).
    drive: (rig) =>
      completeLogin(
        {
          store: rig.root.store,
          adminRule: rig.root.config.admin,
          bootstrap: rig.root.auth.bootstrap,
          logger: silentLogger,
        },
        { subject: 'idp|ops', email: OPERATOR_EMAIL, displayName: 'Ops', groups: [] },
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'bootstrap',
      actor: 'operator',
    },
  },
  'Authenticator.authenticate': exempt(SESSION_STATE),
  'Authenticator.authorizeAdmin': exempt(SESSION_STATE),
  'SessionService.create': exempt(SESSION_STATE),
  'SessionService.read': READ,
  'SessionService.destroyById': exempt(SESSION_STATE),
  'SessionService.destroy': exempt(SESSION_STATE),
  'SessionService.createPending': exempt(SESSION_STATE),
  'SessionService.takePending': exempt(SESSION_STATE),
  'SessionService.clearPendingCookie': READ,

  // ── telemetry (the entry is written by the Administration handler) ────────
  'TelemetrySettingsService.isLocked': READ,
  'TelemetrySettingsService.state': READ,
  'TelemetrySettingsService.enabledNow': READ,
  'TelemetrySettingsService.setEnabled': {
    kind: 'mutation',
    target: (root) => root.telemetry.settings,
    drive: async (rig) =>
      rig.root.telemetry.handlers.setEnabled(
        await rig.operatorPost('/api/admin/telemetry', { enabled: 'true' }),
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'telemetry',
      actor: 'operator',
    },
  },
  'PluginStatsReader.statusFor': READ,
  'PluginStatsReader.refresh': exempt(
    'refreshes the cached copy of the public plugin statistics read from the collector: nothing of the instance is created, changed or revoked',
  ),
  // ── authorization server of the management door ───────────────────────────
  'ClientRegistry.statusOf': READ,
  'ClientRegistry.view': READ,
  'ClientRegistry.find': READ,
  'ClientRegistry.get': READ,
  'ClientRegistry.list': READ,
  'ClientRegistry.register': exempt(OAUTH_PROTOCOL),
  'ClientRegistry.resolveDocumentClient': exempt(
    'stores what a public Client ID Metadata Document says of its client; whether that client may ask users for anything stays the policy’s and the operator’s decision',
  ),
  'ClientRegistry.decide': {
    kind: 'mutation',
    target: (root) => root.oauth.clients,
    // A client that redirects to a server waits for the operator.
    prepare: (rig) => rig.oauthClient('https://agent.example.net/oauth/callback'),
    drive: async (rig, client: OAuthClientRecord) =>
      rig.root.oauth.handlers.decideClient(
        await rig.operatorPost(`/admin/oauth-clients/${client.id}`, { action: 'approve' }),
        client.id,
      ),
    writes: { act: 'oauth-client-approved', object: 'oauth-client', actor: 'operator' },
  },
  'AuthorizationService.needsDocument': READ,
  'AuthorizationService.resolveClient': READ,
  'AuthorizationService.validate': READ,
  'AuthorizationService.createPending': exempt(SESSION_STATE),
  'AuthorizationService.decide': {
    kind: 'mutation',
    target: (root) => root.oauth.authorization,
    prepare: async (rig) => rig.consent(await rig.oauthClient()),
    drive: (rig, shown: { consentId: string }) =>
      rig.root.oauth.authorization.decide(rig.alice.user, shown.consentId, 'approve'),
    writes: { act: 'delegation-granted', object: 'delegation', actor: 'alice' },
  },
  'TokenService.authenticateClient': READ,
  'TokenService.exchangeCode': exempt(OAUTH_PROTOCOL),
  'TokenService.refresh': exempt(OAUTH_PROTOCOL),
  'TokenService.revoke': {
    kind: 'mutation',
    target: (root) => root.oauth.tokens,
    prepare: (rig) => rig.delegation(),
    // The client signs out: its refresh token ends the delegation, in the user's name.
    drive: (rig, held: { client: OAuthClientRecord; tokens: TokenResponse }) =>
      rig.root.oauth.tokens.revoke(
        held.client,
        new URLSearchParams({ token: held.tokens.refresh_token }),
      ),
    writes: { act: 'delegation-revoked', object: 'delegation', actor: 'alice' },
  },
  'DelegationService.listFor': READ,
  'DelegationService.revoke': {
    kind: 'mutation',
    target: (root) => root.oauth.delegations,
    prepare: (rig) => rig.delegation(),
    drive: (rig, held: { id: string }) =>
      rig.root.oauth.delegations.revoke(rig.alice.user, held.id),
    writes: { act: 'delegation-revoked', object: 'delegation', actor: 'alice' },
  },
  'DelegatedTokenVerifier.resolve': READ,
  'DelegatedTokenVerifier.verifyAccessToken': READ,
  'ManagementGate.admit': READ,
  // ── management door: an agent acting for the user, under a delegation ─────
  'ManagementDoor.handle': READ,
  'ManagementTools.listMyConnections': READ,
  'ManagementTools.getCatalog': READ,
  'ManagementTools.listMyMissions': READ,
  'ManagementTools.previewPolicy': READ,
  'ManagementTools.issueMission': {
    kind: 'mutation',
    target: managementTools,
    prepare: async (rig) => ({
      connection: await rig.connectByKey(),
      actor: await delegatedActor(rig),
    }),
    drive: (rig, prepared: { connection: ConnectionRecord; actor: ManagementActor }) =>
      rig.root.management.tools.issueMission(prepared.actor, {
        name: 'Read the things',
        connections: [{ connection_id: prepared.connection.id, preset: 'reader' }],
        period: { kind: 'one-off' },
        expires_at: null,
      }),
    writes: { act: 'mission-issued', object: 'mission', actor: 'alice', delegated: true },
  },
  'ManagementTools.rotateMissionToken': {
    kind: 'mutation',
    target: managementTools,
    prepare: async (rig) => ({ mission: await rig.issue(), actor: await delegatedActor(rig) }),
    drive: (rig, prepared: { mission: MissionRecord; actor: ManagementActor }) =>
      rig.root.management.tools.rotateMissionToken(prepared.actor, {
        mission_id: prepared.mission.id,
      }),
    writes: { act: 'mission-rotated', object: 'mission', actor: 'alice', delegated: true },
  },
  'ManagementTools.revokeMission': {
    kind: 'mutation',
    target: managementTools,
    prepare: async (rig) => ({ mission: await rig.issue(), actor: await delegatedActor(rig) }),
    drive: (rig, prepared: { mission: MissionRecord; actor: ManagementActor }) =>
      rig.root.management.tools.revokeMission(prepared.actor, { mission_id: prepared.mission.id }),
    writes: { act: 'mission-revoked', object: 'mission', actor: 'alice', delegated: true },
  },
};

const MUTATIONS = Object.entries(RULES).flatMap(([name, rule]) =>
  rule.kind === 'mutation' ? [{ name, rule }] : [],
);

describe('every administrative mutation writes an admin audit entry', () => {
  let rig: Rig | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await rig?.root.close();
    rig = null;
  });

  it('every public service method is classified: read, mutation or exempt with a reason', () => {
    const declared = publicMethods();
    expect(declared.length).toBeGreaterThan(40);
    expect(declared.filter((name) => !(name in RULES))).toEqual([]);
    // No stale row either: a renamed or removed method takes its rule with it.
    expect(Object.keys(RULES).filter((name) => !declared.includes(name))).toEqual([]);
    for (const [name, rule] of Object.entries(RULES)) {
      if (rule.kind === 'exempt') expect(rule.why.length, name).toBeGreaterThan(20);
    }
  });

  it('covers every mutating act the services can perform', () => {
    expect(MUTATIONS.map((m) => m.rule.writes.act).sort()).toEqual([
      'approval-granted',
      'config-changed',
      'config-changed',
      'config-changed',
      'config-changed',
      'config-changed',
      'config-changed',
      'connection-created',
      'connection-created',
      'connection-reassigned',
      'connection-revoked',
      'connection-transferred',
      'delegation-granted',
      'delegation-revoked',
      'delegation-revoked',
      'gate-changed',
      'group-created',
      'group-member-added',
      'group-member-removed',
      'mission-issued',
      'mission-issued',
      'mission-issued',
      'mission-orphaned',
      'mission-orphaned',
      'mission-restored',
      'mission-revoked',
      'mission-revoked',
      'mission-rotated',
      'mission-rotated',
      'oauth-client-approved',
      'period-reset',
      'request-refused',
      'resource-edited',
      'resources-discovered',
      'share-created',
      'share-revoked',
    ]);
  });

  it.each(MUTATIONS)('$name writes $rule.writes.act', async ({ name, rule }) => {
    rig = await openRig();
    const { root } = rig;
    const method = name.slice(name.indexOf('.') + 1);
    const prepared = rule.prepare ? await rule.prepare(rig) : undefined;
    const before = new Set((await root.store.audit.list({ kind: 'admin' })).map((e) => e.id));
    const spy = vi.spyOn(rule.target(root) as Record<string, () => unknown>, method);

    await rule.drive(rig, prepared as never);

    // The driver really went through the method under test, and it did not throw.
    expect(spy, name).toHaveBeenCalled();
    expect(spy.mock.results.every((r) => r.type === 'return')).toBe(true);
    await Promise.all(spy.mock.results.map((r): unknown => r.value)); // rejects if a call failed

    const written = (await root.store.audit.list({ kind: 'admin' })).filter(
      (e) => !before.has(e.id),
    );
    const actorId = rule.writes.actor === 'alice' ? rig.alice.user.id : rig.operator.id;
    const matching = written.flatMap((e) =>
      e.kind === 'admin' &&
      e.act === rule.writes.act &&
      e.object.type === rule.writes.object &&
      (rule.writes.objectId === undefined || e.object.id === rule.writes.objectId) &&
      e.user_id === actorId
        ? [e]
        : [],
    );
    expect(matching, `${name}: admin entries written = ${JSON.stringify(written)}`).toHaveLength(1);
    const [entry] = matching;
    expect(entry?.object.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(entry?.ts ?? ''))).toBe(false);
    if (rule.writes.delegated) {
      expect(entry?.delegated_client_id, name).toMatch(/^vbn_client_/);
    } else if (rule.writes.act.startsWith('mission-')) {
      // An act of the interface names no client.
      expect(entry?.delegated_client_id ?? null, name).toBeNull();
    }
  });

  it.each([
    ['grant', 'approval-granted'],
    ['open-gate', 'gate-opened'],
    ['refuse', 'request-refused'],
  ] as const)(
    'an approval request decided "%s" writes %s, through either entry point',
    async (resolution, act) => {
      rig = await openRig();
      const { root, alice } = rig;
      for (const decide of [
        (id: string) => root.requests.service.decide(alice.user, id, { resolution }),
        (id: string) => root.requests.service.decideApproval(alice.user, id, { resolution }),
      ]) {
        const requestId = await rig.approvalRequest();
        const before = new Set((await root.store.audit.list({ kind: 'admin' })).map((e) => e.id));
        expect(await decide(requestId)).toMatchObject({ ok: true });
        const written = (await root.store.audit.list({ kind: 'admin' })).filter(
          (e) => !before.has(e.id),
        );
        expect(written).toMatchObject([
          {
            kind: 'admin',
            act,
            user_id: alice.user.id,
            object: { type: 'request', id: requestId },
          },
        ]);
      }
    },
  );

  it('a resource edit records the fields before and after, and a save that changes nothing records none', async () => {
    rig = await openRig();
    const { root, alice } = rig;
    const connection = await rig.connectByKey();
    const [resource] = await root.store.connections.listResources(connection.id);
    if (!resource) throw new Error('expected a discovered resource');
    const edits = async () =>
      (await root.store.audit.list({ kind: 'admin' })).filter(
        (e) => e.kind === 'admin' && e.act === 'resource-edited',
      );

    await root.connections.service.updateResource(alice, connection.id, resource.id, {
      env: 'staging',
      hidden: true,
    });
    expect(await edits()).toMatchObject([
      {
        object: { type: 'connection', id: connection.id },
        before: { resource_id: resource.id, ref: 'acct-a', env: null, hidden: false },
        after: { resource_id: resource.id, ref: 'acct-a', env: 'staging', hidden: true },
      },
    ]);

    await root.connections.service.updateResource(alice, connection.id, resource.id, {
      env: 'staging',
      hidden: true,
    });
    expect(await edits()).toHaveLength(1);
  });

  it('a discovery that fails is recorded too, with the reason', async () => {
    rig = await openRig();
    const { root, alice } = rig;
    const connection = await rig.connectByKey();
    await root.store.connections.revoke(connection.id);
    const reconnectable = await root.store.connections.create({
      provider: 'keyco',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'No credential',
      credential: null,
    });

    const outcome = await root.connections.service.discover(alice, reconnectable.id);
    expect(outcome.ok).toBe(false);
    const entry = (await root.store.audit.list({ kind: 'admin' })).at(-1);
    expect(entry).toMatchObject({
      act: 'resources-discovered',
      object: { type: 'connection', id: reconnectable.id },
      after: { ok: false, count: 0, error: outcome.error },
    });
  });
});
