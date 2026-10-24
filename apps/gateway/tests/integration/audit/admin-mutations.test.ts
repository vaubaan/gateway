/**
 * Structural test (spec §8 "one entry … per administrative act"
 * "every admin mutation path writes an admin audit entry — the test
 * enumerates the service methods").
 *
 * The public methods of every class under `server/{connections,
 * missions,auth,requests,telemetry,instance,authority,shares,groups,users,oauth-as,management}` are
 * read from the source with the TypeScript
 * parser and each must be classified below as a read, a mutation or an
 * exemption with its reason. A method added tomorrow fails the first test
 * until it is classified; a mutation is then driven on an ephemeral instance
 * and must leave the administrative entry named next to it.
 */
import { switchOnForTests } from '../../../src/server/auth/testing';
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
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { generateEd25519KeyPair, type Actor } from '../../../src/server/connections';
import {
  API_KEY_SPEC,
  SSH_KEY_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  seedRegisteredClient,
  stateOf,
} from '../../../src/server/connections/testing';
import type { IssuedLink } from '../../../src/server/auth';
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import type { LocalAccountRecord } from '../../../src/server/store';
import type { ManagementActor } from '../../../src/server/management';
import type { TokenResponse } from '../../../src/server/oauth-as';
import { pkcePair } from '../../../src/server/oauth-as/testing';
import { answerAnyDiscovery } from '../auth/fake-idp';
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
  'missions',
  'auth',
  'requests',
  'telemetry',
  'instance',
  'authority',
  'shares',
  'groups',
  'users',
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
          envs: ['staging', 'prod'],
          discoverResources: async () => [
            { provider: 'keyco', ref: 'acct-a', displayName: 'Account A' },
          ],
        }),
        fixturePlugin({
          id: 'sshco',
          credential: SSH_KEY_SPEC,
          discoverResources: async () => [
            { provider: 'sshco', ref: 'vps.example.com', displayName: 'VPS' },
          ],
        }),
        fixturePlugin({ id: 'oauthco', credential: OAUTH_SPEC }),
      ]),
    providerFetch: provider,
    // The identity-provider form checks the issuer's discovery document before saving.
    oidc: { fetch: answerAnyDiscovery },
    ...memoryStoreDeps,
  });
  const operator = await root.store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'idp|ops',
    email: OPERATOR_EMAIL,
  });
  const aliceUser = await root.store.users.upsertFromIdp({
    issuer: 'http://idp.test',
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
      // The client the gateway would have registered at the provider (not what is audited here).
      await seedRegisteredClient(root.store.config, {
        providerId: 'oauthco',
        clientId: 'cid',
        clientSecret: 'csecret',
        redirectUri: root.connections.service.callbackUrl('oauthco').href,
        at: new Date(),
      });
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
      return root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'idp|bob',
        email: 'bob@example.com',
      });
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
const accounts = (root: GatewayRoot) => root.auth.accounts;
const LOCAL_OBJECT = 'local-account:local';
const LOCAL_PASSWORD = 'a sentence long enough';

/** A provider of kind `local`, added as Settings would. */
async function localProvider(rig: Rig): Promise<void> {
  await rig.root.auth.providers.save(
    {
      id: 'local',
      kind: 'local',
      name: '',
      issuer: '',
      clientId: '',
      clientSecret: null,
      allowedEmailDomains: [],
      invitationOnly: true,
    },
    'create',
  );
}

/** The provider and one account, created by the operator. */
async function localAccount(rig: Rig): Promise<LocalAccountRecord> {
  await localProvider(rig);
  return rig.root.auth.accounts.createAccount({
    providerId: 'local',
    email: 'local@example.com',
    password: LOCAL_PASSWORD,
    actor: rig.operator.id,
  });
}
const missions = (root: GatewayRoot) => root.missions.service;
const managementTools = (root: GatewayRoot) => root.management.tools;
const team = (root: GatewayRoot) => root.missions.team;

/** A mission of Alice with Bob as a member (he has generated no token yet). */
async function sharedWithBob(rig: Rig): Promise<{ mission: MissionRecord; bob: UserRecord }> {
  const mission = await rig.issue();
  const bob = await rig.bob();
  const added = await rig.root.missions.team.addMember(rig.alice.user, mission.id, {
    email: bob.email,
  });
  if (!added.ok) throw new Error(`add refused: ${added.reason}`);
  return { mission, bob };
}

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
  'ConnectionService.defaultEnvChoices': READ,
  'ConnectionService.setDefaultEnv': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, connection: ConnectionRecord) =>
      rig.root.connections.service.setDefaultEnv(rig.alice, connection.id, 'staging'),
    writes: { act: 'connection-default-env-set', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.callbackUrl': READ,
  'ConnectionService.start': {
    kind: 'mutation',
    target: connections,
    drive: (rig) => rig.connectByKey(),
    writes: { act: 'connection-created', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.importPastedKey': {
    kind: 'mutation',
    target: connections,
    drive: (rig) =>
      rig.root.connections.service.importPastedKey(rig.alice, 'keyco', {
        displayName: 'Imported key',
        fields: { token: 'key-0123456789', team_id: 'team_abc' },
        importedFrom: { system: 'vaubaan-v4', org: 'acme', source: 'provider_admins/1' },
      }),
    writes: { act: 'connection-created', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.importSshKey': {
    kind: 'mutation',
    target: connections,
    drive: (rig) =>
      rig.root.connections.service.importSshKey(rig.alice, {
        providerId: 'sshco',
        displayName: 'vps',
        fields: { host: 'vps.example.com', user: 'dev' },
        keyPair: generateEd25519KeyPair('v4'),
        importedFrom: { system: 'vaubaan-v4', org: 'acme', source: 'ssh_bindings/acme/vps' },
      }),
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
  // The gateway's own discovery after a call that created a resource (ADR
  // discovery-runs-after-a-creating-call): one entry per scheduled discovery,
  // written once its attempts are over; the actor is the human behind the key.
  'ConnectionService.auditDiscoveryAfterCall': {
    kind: 'mutation',
    target: connections,
    prepare: (rig) => rig.connectByKey(),
    drive: async (rig, connection: ConnectionRecord) => {
      const cause = { missionId: 'mis_after_call', tool: 'keyco__create_thing' };
      const outcome = await rig.root.connections.service.discoverAfterCall(connection.id, cause);
      if (!outcome) throw new Error('expected the connection to serve');
      return rig.root.connections.service.auditDiscoveryAfterCall(
        connection.id,
        { ...cause, userId: rig.alice.user.id },
        { ...outcome, attempts: 1 },
      );
    },
    writes: { act: 'resources-discovered', object: 'connection', actor: 'alice' },
  },
  'ConnectionService.discoverAfterCall': exempt(
    'one attempt of the discovery DiscoveryAfterCall runs after a creating call; the scheduler audits its outcome once, through ConnectionService.auditDiscoveryAfterCall (resources-discovered, cause after-a-call)',
  ),
  'DiscoveryAfterCall.afterCall': exempt(
    'the execution door hook: it only schedules; the discovery it schedules is audited through ConnectionService.auditDiscoveryAfterCall',
  ),
  'DiscoveryAfterCall.schedule': exempt(
    'queues a discovery for later; the discovery, once run, is audited through ConnectionService.auditDiscoveryAfterCall',
  ),
  'DiscoveryAfterCall.idle': READ,
  'DiscoveryAfterCall.stop': exempt(
    'the shutdown of the process (root.close): it schedules nothing more and waits for the discovery in flight, which audits itself',
  ),
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
  'ConnectionService.providerGrantOf': READ,
  'ConnectionService.listOwnerless': READ,
  'ConnectionService.reassignTargets': READ,
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
  'CredentialBroker.forRevocation': READ,
  'CredentialBroker.withdrawAtProvider': exempt(
    'a step of ConnectionService.revoke, whose connection-revoked entry carries what the provider answered (after.provider_grant); it writes nothing in the store itself',
  ),
  'CredentialBroker.refresh': exempt(SYSTEM_REFRESH),
  'OAuth2Clients.forTokenRequest': READ,
  'OAuth2Clients.forAuthorization': exempt(
    "registers the instance's own OAuth client at a service that accepts dynamic registration, as a step of a person's connect (ADR oauth-client-registered-by-the-gateway): nobody chose it, and the connection-created entry follows; the instance log names the provider and the client id",
  ),
  'OAuth2Clients.rejected': exempt(
    'forgets a registered client the provider refused (invalid_client), during an exchange or a refresh, with no human act: the next connect registers again; the instance log says so',
  ),
  'PendingConnectStore.create': exempt(SESSION_STATE),
  'PendingConnectStore.take': exempt(SESSION_STATE),
  'NoticeStore.put': exempt(SESSION_STATE),
  'NoticeStore.take': exempt(SESSION_STATE),
  'PendingShareStore.put': exempt(SESSION_STATE),
  'PendingShareStore.read': exempt(SESSION_STATE),

  // ── missions ──────────────────────────────────────────────────────────────
  'MissionService.permissionOptions': READ,
  'MissionService.issuanceContext': READ,
  'MissionService.preview': READ,
  'MissionService.draftFrom': READ,
  'MissionService.verifyToken': exempt(
    'authentication of a call, not an administrative act; its one write replaces the stored hash of a token an earlier build stored as argon2id by the sha256 digest of the same secret (same row, same holder, same status), and is logged',
  ),
  'MissionService.list': READ,
  'MissionService.get': READ,
  'MissionService.access': READ,
  'MissionService.stateOf': READ,
  'MissionService.stateAfterRefusal': READ,
  'MissionService.kitOf': READ,
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
  'MissionService.orphanedOn': READ,
  'MissionService.onConnection': READ,
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

  'MissionService.changePermissions': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.changePermissions(rig.alice.user, mission.id, {
        policy: [],
        expected_policy: mission.policy.map((p) => ({
          risk_id: p.riskId,
          quota: p.quota,
          rate_limit: { max: p.rateLimit, window_seconds: p.rateWindowSeconds },
          gate: p.gate,
        })),
      }),
    writes: { act: 'permissions-changed', object: 'mission', actor: 'alice' },
  },
  'MissionService.editView': READ,
  'MissionService.previewEdit': READ,
  'MissionService.edit': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: async (rig, mission: MissionRecord) => {
      const view = await rig.root.missions.service.editView(rig.alice.user, mission.id);
      return rig.root.missions.service.edit(rig.alice.user, mission.id, {
        draft: { ...view?.draft, name: `${mission.name} (edited)` },
        revision: view?.revision,
      });
    },
    writes: { act: 'mission-changed', object: 'mission', actor: 'alice' },
  },
  'MissionService.setLimits': {
    kind: 'mutation',
    target: missions,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.setLimits(rig.alice.user, mission.id, [
        {
          risk_id: mission.policy[0]?.riskId ?? '',
          quota: (mission.policy[0]?.quota ?? 1) + 1,
          rate_limit_max: mission.policy[0]?.rateLimit ?? 1,
        },
      ]),
    writes: { act: 'limits-changed', object: 'mission', actor: 'alice' },
  },

  // ── missions: members and per-holder tokens ───────────────────────────────
  'MissionTeamService.team': READ,
  'UserNames.get': READ,
  'UserNames.label': READ,
  'MissionTeamService.addMember': {
    kind: 'mutation',
    target: team,
    prepare: async (rig) => ({ mission: await rig.issue(), bob: await rig.bob() }),
    drive: (rig, prepared: { mission: MissionRecord; bob: UserRecord }) =>
      rig.root.missions.team.addMember(rig.alice.user, prepared.mission.id, {
        email: prepared.bob.email,
      }),
    writes: { act: 'mission-member-added', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.removeMember': {
    kind: 'mutation',
    target: team,
    prepare: (rig) => sharedWithBob(rig),
    drive: (rig, prepared: { mission: MissionRecord; bob: UserRecord }) =>
      rig.root.missions.team.removeMember(rig.alice.user, prepared.mission.id, prepared.bob.id),
    writes: { act: 'mission-member-removed', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.generateToken': {
    kind: 'mutation',
    target: team,
    prepare: (rig) => rig.issue(),
    // Alice holds the token her mission was born with: generating again is a rotation.
    // (A member's first token is `mission-token-issued`, as a named token below.)
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.team.generateToken(rig.alice.user, mission.id),
    writes: { act: 'mission-rotated', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.createNamedToken': {
    kind: 'mutation',
    target: team,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.team.createNamedToken(rig.alice.user, mission.id, 'CI runner'),
    writes: { act: 'mission-token-issued', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.revokeToken': {
    kind: 'mutation',
    target: team,
    prepare: async (rig) => {
      const mission = await rig.issue();
      const [token] = await rig.root.store.missions.listTokens(mission.id);
      if (!token) throw new Error('expected the token the mission was born with');
      return { mission, tokenId: token.id };
    },
    drive: (rig, prepared: { mission: MissionRecord; tokenId: string }) =>
      rig.root.missions.team.revokeToken(rig.alice.user, prepared.mission.id, prepared.tokenId),
    writes: { act: 'mission-token-revoked', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.replaceNamedToken': {
    kind: 'mutation',
    target: team,
    prepare: async (rig) => {
      const mission = await rig.issue();
      const made = await rig.root.missions.team.createNamedToken(
        rig.alice.user,
        mission.id,
        'CI runner',
      );
      if (!made.ok) throw new Error('expected a machine key');
      const named = (await rig.root.store.missions.listTokens(mission.id)).find(
        (t) => t.holder.kind === 'named',
      );
      if (!named) throw new Error('expected the machine key row');
      return { mission, tokenId: named.id };
    },
    drive: (rig, prepared: { mission: MissionRecord; tokenId: string }) =>
      rig.root.missions.team.replaceNamedToken(
        rig.alice.user,
        prepared.mission.id,
        prepared.tokenId,
      ),
    writes: { act: 'mission-rotated', object: 'mission', actor: 'alice' },
  },
  'MissionTeamService.leave': {
    kind: 'mutation',
    target: team,
    // The operator is a user like any other: Alice gives them a seat on her mission.
    prepare: async (rig) => {
      const mission = await rig.issue();
      const added = await rig.root.missions.team.addMember(rig.alice.user, mission.id, {
        email: rig.operator.email,
      });
      if (!added.ok) throw new Error(`add refused: ${added.reason}`);
      return mission;
    },
    drive: (rig, mission: MissionRecord) => rig.root.missions.team.leave(rig.operator, mission.id),
    writes: { act: 'mission-member-left', object: 'mission', actor: 'operator' },
  },
  'MissionTeamService.revokeTokensOfDeactivated': {
    kind: 'mutation',
    target: team,
    // Reached through the one act that calls it: an operator deactivating a member.
    prepare: async (rig) => {
      const prepared = await sharedWithBob(rig);
      const generated = await rig.root.missions.team.generateToken(
        prepared.bob,
        prepared.mission.id,
      );
      if (!generated.ok) throw new Error(`generate refused: ${generated.reason}`);
      return prepared;
    },
    drive: (rig, prepared: { bob: UserRecord }) =>
      rig.root.users.service.deactivate(
        { actorId: rig.operator.id, userId: rig.operator.id },
        prepared.bob.id,
      ),
    writes: { act: 'mission-token-revoked', object: 'mission', actor: 'operator' },
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
  // What a share would restore, asked before it is made: nothing is written.
  'MissionGrounds.forecastShare': READ,
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
  'ShareService.holders': READ,
  'ShareService.forecast': READ,
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
  'RequestService.waiting': READ,
  'RequestService.answered': READ,
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
  'SignInProvidersService.views': READ,
  'SignInProvidersService.view': READ,
  'SignInProvidersService.resolve': READ,
  'SignInProvidersService.ofIssuer': READ,
  'SignInProvidersService.isReadOnly': READ,
  'SignInProvidersService.state': READ,
  'SignInProvidersService.setWaiver': {
    kind: 'mutation',
    target: (root) => root.auth.providers,
    prepare: (rig) =>
      rig.root.auth.idp.save({
        issuer: 'https://idp.example.com',
        clientId: 'c',
        clientSecret: 's',
        claims: { sub: 'sub', email: 'email', groups: 'groups' },
        allowedEmailDomains: [],
      }),
    drive: async (rig) =>
      rig.root.auth.handlers.setSecondFactorWaiver(
        await rig.operatorPost('/api/admin/sign-in-providers/idp/waiver', { waiver: 'amr' }),
        'idp',
      ),
    writes: {
      act: 'second-factor-waiver-changed',
      object: 'instance-config',
      objectId: 'idp',
      actor: 'operator',
    },
  },
  'SignInProvidersService.recordTest': exempt(
    'the outcome of a test beside the session, recorded by the handler that writes its `sign-in-provider-tested` entry (tests/integration/auth/provider-test.test.ts)',
  ),
  'SignInProvidersService.setEnabled': {
    kind: 'mutation',
    target: (root) => root.auth.providers,
    prepare: async (rig) => {
      await rig.root.auth.providers.save(
        {
          id: 'github',
          kind: 'github',
          name: '',
          issuer: '',
          clientId: 'Ov23liAuditTest',
          clientSecret: 'github-sign-in-secret',
          allowedEmailDomains: [],
          invitationOnly: true,
        },
        'create',
      );
      await switchOnForTests(rig.root.store.config, 'github');
    },
    drive: async (rig) =>
      rig.root.auth.handlers.disableSignInProvider(
        await rig.operatorPost('/api/admin/sign-in-providers/github/disable', {}),
        'github',
      ),
    writes: {
      act: 'sign-in-provider-disabled',
      object: 'instance-config',
      objectId: 'sign-in:github',
      actor: 'operator',
    },
  },
  'SignInProvidersService.carryIntoStore': exempt(
    'the backup command writes it into its copy of the store, never into the live store: nobody acts on this instance (ADR backup-carries-the-sign-in-configuration)',
  ),
  'SignInProvidersService.save': {
    kind: 'mutation',
    target: (root) => root.auth.providers,
    drive: async (rig) =>
      rig.root.auth.handlers.saveIdpSettings(
        await rig.operatorPost('/api/admin/sign-in-providers', {
          mode: 'create',
          provider_id: 'github',
          kind: 'github',
          client_id: 'Ov23liAuditTest',
          client_secret: 'github-sign-in-secret',
          admission: 'invited',
        }),
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'sign-in:github',
      actor: 'operator',
    },
  },
  'SignInProvidersService.remove': {
    kind: 'mutation',
    target: (root) => root.auth.providers,
    prepare: (rig) =>
      rig.root.auth.providers.save(
        {
          id: 'github',
          kind: 'github',
          name: '',
          issuer: '',
          clientId: 'Ov23liAuditTest',
          clientSecret: 'github-sign-in-secret',
          allowedEmailDomains: [],
          invitationOnly: true,
        },
        'create',
      ),
    drive: async (rig) =>
      rig.root.auth.handlers.removeSignInProvider(
        await rig.operatorPost('/api/admin/sign-in-providers/github/remove', {}),
        'github',
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'sign-in:github',
      actor: 'operator',
    },
  },
  'GithubSignIn.start': exempt(
    'a sign-in attempt: only the pending login is written, a session-state record',
  ),
  'GithubSignIn.finish': exempt(
    'reads the identity from GitHub; what the sign-in writes is completeLogin’s, audited there',
  ),
  'GithubSignIn.scopes': READ,
  'InvitationService.list': READ,
  'InvitationService.isInvited': READ,
  'InvitationService.invite': {
    kind: 'mutation',
    target: (root) => root.users.invitations,
    drive: async (rig) =>
      rig.root.users.handlers.invite(
        await rig.operatorPost('/admin/users/invitations', { email: 'guest@example.org' }),
      ),
    writes: {
      act: 'invitation-added',
      object: 'instance-config',
      objectId: 'invitations',
      actor: 'operator',
    },
  },
  'InvitationService.remove': {
    kind: 'mutation',
    target: (root) => root.users.invitations,
    prepare: (rig) => rig.root.users.invitations.invite(rig.operator.id, 'guest@example.org'),
    drive: async (rig) =>
      rig.root.users.handlers.removeInvitation(
        await rig.operatorPost('/admin/users/invitations/remove', { email: 'guest@example.org' }),
      ),
    writes: {
      act: 'invitation-removed',
      object: 'instance-config',
      objectId: 'invitations',
      actor: 'operator',
    },
  },
  'BootstrapService.state': READ,
  'BootstrapService.verify': READ,
  'BootstrapService.recordMiss': exempt(
    'counts a wrong bootstrap token presented anonymously (no actor to name); at the threshold it revokes the token through revoke(), which the instance logs at error',
  ),
  'BootstrapService.revoke': {
    kind: 'mutation',
    target: (root) => root.auth.bootstrap,
    // "Finish setup" revokes the bootstrap token (ADR administrators-live-in-the-instance, §8):
    // an administrator with a way in exists (a local account named by the setup).
    prepare: async (rig) => {
      await localProvider(rig);
      const account = await rig.root.auth.accounts.createAccount({
        providerId: 'local',
        email: 'first@example.com',
        password: LOCAL_PASSWORD,
        actor: rig.operator.id,
      });
      const user = await rig.root.store.users.ensureIdentity({
        issuer: 'urn:vaubaan:local:local',
        subject: account.id,
        email: account.email,
      });
      await rig.root.auth.administrators.grantUser(user.id, rig.operator.id);
    },
    drive: async (rig) =>
      rig.root.users.handlers.finishSetup(await rig.operatorPost('/api/admin/setup/finish', {})),
    writes: {
      act: 'setup-finished',
      object: 'instance-config',
      objectId: 'bootstrap',
      actor: 'operator',
    },
  },
  'Authenticator.authenticate': exempt(SESSION_STATE),
  'Authenticator.authorizeAdmin': exempt(SESSION_STATE),
  // The administrators of the store (ADR administrators-live-in-the-instance).
  'AdministratorsService.current': READ,
  'AdministratorsService.any': READ,
  'AdministratorsService.isAdministrator': READ,
  'AdministratorsService.providerIdOf': READ,
  'AdministratorsService.admits': READ,
  'AdministratorsService.designationOfUser': READ,
  'AdministratorsService.withAWayIn': READ,
  'AdministratorsService.assertNoLockout': READ,
  'AdministratorsService.configurationDrift': READ,
  'AdministratorsService.consumeAtSignIn': {
    kind: 'mutation',
    target: (root) => root.auth.administrators,
    prepare: (rig) =>
      rig.root.auth.administrators.grantEmail('newcomer@example.org', null, rig.operator.id),
    drive: async (rig) =>
      rig.root.auth.administrators.consumeAtSignIn(
        await rig.root.store.users.upsertFromIdp({
          issuer: 'http://idp.test',
          subject: 'idp|newcomer',
          email: 'newcomer@example.org',
        }),
        'idp',
      ),
    writes: {
      act: 'administrator-granted',
      object: 'instance-config',
      objectId: 'administrators',
      actor: 'operator',
    },
  },
  'AdministratorsService.grantUser': {
    kind: 'mutation',
    target: (root) => root.auth.administrators,
    drive: async (rig) =>
      rig.root.users.handlers.makeAdministrator(
        await rig.operatorPost(`/admin/users/${rig.alice.user.id}/make-administrator`, {}),
        rig.alice.user.id,
      ),
    writes: {
      act: 'administrator-granted',
      object: 'instance-config',
      objectId: 'administrators',
      actor: 'operator',
    },
  },
  'AdministratorsService.grantEmail': {
    kind: 'mutation',
    target: (root) => root.auth.administrators,
    drive: (rig) =>
      rig.root.auth.administrators.grantEmail('later@example.org', null, rig.operator.id),
    writes: {
      act: 'administrator-granted',
      object: 'instance-config',
      objectId: 'administrators',
      actor: 'operator',
    },
  },
  'AdministratorsService.grantGroup': {
    kind: 'mutation',
    target: (root) => root.auth.administrators,
    prepare: (rig) =>
      rig.root.auth.idp.save({
        issuer: 'https://idp.example.com',
        clientId: 'c',
        clientSecret: 's',
        claims: { sub: 'sub', email: 'email', groups: 'groups' },
        allowedEmailDomains: [],
      }),
    drive: async (rig) =>
      rig.root.users.handlers.addAdministratorGroup(
        await rig.operatorPost('/admin/users/administrators/group', {
          provider: 'idp',
          group: 'platform',
        }),
      ),
    writes: {
      act: 'administrator-granted',
      object: 'instance-config',
      objectId: 'administrators',
      actor: 'operator',
    },
  },
  'AdministratorsService.revoke': {
    kind: 'mutation',
    target: (root) => root.auth.administrators,
    prepare: (rig) =>
      rig.root.auth.administrators.grantEmail('later@example.org', null, rig.operator.id),
    drive: async (rig) => {
      const pending = (await rig.root.store.administrators.list()).find(
        (d) => d.kind === 'email' && d.email === 'later@example.org',
      );
      return rig.root.users.handlers.removeAdministratorDesignation(
        await rig.operatorPost('/admin/users/administrators/remove', {
          designation: pending?.id ?? '',
        }),
      );
    },
    writes: {
      act: 'administrator-revoked',
      object: 'instance-config',
      objectId: 'administrators',
      actor: 'operator',
    },
  },
  'AdministratorsService.seedFromConfiguration': exempt(
    'run by the boot alone, before any request: its `administrators-seeded` entry names the configuration as actor (tests/integration/auth/administrators.test.ts)',
  ),
  'AdministratorsService.applyConfiguration': exempt(
    'writes one `administrator-granted` entry per designation through grantUser/grantEmail, classified above, or none when the rule names nobody new (tests/integration/auth/administrators.test.ts)',
  ),
  // Local accounts (ADR local-accounts-sign-in-provider): the service audits what an
  // administrator or a link does; a person's own sign-in (the password, the second
  // factor) writes counters and spends codes but is no administrative act.
  'LocalAccountsService.linkUrl': READ,
  'LocalAccountsService.inspectLink': READ,
  'LocalAccountsService.accountOf': READ,
  'LocalAccountsService.accountById': READ,
  'LocalAccountsService.list': READ,
  'LocalAccountsService.pendingLinks': READ,
  'RecoveryService.banner': READ,
  'RecoveryService.isOpen': READ,
  'RecoveryService.challenge': exempt(
    'anonymous: a challenge record bound to a cookie, session state of the recovery page (spec §8 names a human actor)',
  ),
  'RecoveryService.prove': exempt(
    'anonymous: checks a proof and opens a recovery session that can only name an administrator; a refused proof is logged at error; what the session does is audited by name()',
  ),
  'RecoveryService.name': exempt(
    'no human actor: the holder of the master key; writes `administrator-recovered` (actor `recovery`) besides the designation’s own `administrator-granted` (tests/integration/auth/recovery.test.ts)',
  ),
  'SecondFactorService.has': READ,
  'SecondFactorService.beginEnrolment': READ,
  'SecondFactorService.recoveryCodesLeft': READ,
  'SecondFactorService.adoptLocalFactors': exempt(
    'run by the boot alone: moves the factors local accounts kept to their people, a change of storage and of nobody’s authority (tests/integration/auth/second-factor.test.ts)',
  ),
  'LocalAccountsService.checkPassword': exempt(
    'the person’s own sign-in: counts a wrong password towards the lockout and clears the count on a right one; refusals are logged, not audited (spec §8 names a human actor)',
  ),
  'SecondFactorService.check': exempt(
    'the person’s own sign-in: advances the accepted time step or spends a recovery code; a sign-in by recovery code is logged',
  ),
  'LocalAccountsService.createLink': {
    kind: 'mutation',
    target: accounts,
    prepare: localAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.accounts.createLink({
        kind: 'reset',
        providerId: 'local',
        email: (prepared as LocalAccountRecord).email,
        createdBy: rig.operator.id,
      }),
    writes: {
      act: 'local-link-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'LocalAccountsService.createAccount': {
    kind: 'mutation',
    target: accounts,
    prepare: localProvider,
    drive: (rig) =>
      rig.root.auth.accounts.createAccount({
        providerId: 'local',
        email: 'fresh@example.com',
        password: LOCAL_PASSWORD,
        actor: rig.operator.id,
      }),
    writes: {
      act: 'local-account-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'LocalAccountsService.createAccountFromLink': {
    kind: 'mutation',
    target: accounts,
    prepare: async (rig) => {
      await localProvider(rig);
      return rig.root.auth.accounts.createLink({
        kind: 'invite',
        providerId: 'local',
        email: 'invited@example.com',
        createdBy: rig.operator.id,
      });
    },
    drive: (rig, prepared: never) =>
      rig.root.auth.accounts.createAccountFromLink((prepared as IssuedLink).token, LOCAL_PASSWORD),
    writes: {
      act: 'local-account-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'LocalAccountsService.resetPasswordFromLink': {
    kind: 'mutation',
    target: accounts,
    prepare: async (rig) => {
      const account = await localAccount(rig);
      return rig.root.auth.accounts.createLink({
        kind: 'reset',
        providerId: 'local',
        email: account.email,
        createdBy: rig.operator.id,
      });
    },
    drive: (rig, prepared: never) =>
      rig.root.auth.accounts.resetPasswordFromLink(
        (prepared as IssuedLink).token,
        'another sentence long enough',
      ),
    writes: {
      act: 'local-password-changed',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'LocalAccountsService.changePassword': {
    kind: 'mutation',
    target: accounts,
    prepare: localAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.accounts.changePassword(
        (prepared as LocalAccountRecord).id,
        'another sentence long enough',
        rig.operator.id,
      ),
    writes: {
      act: 'local-password-changed',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SecondFactorService.confirmEnrolment': {
    kind: 'mutation',
    target: (root) => root.auth.secondFactors,
    drive: async (rig) => {
      const { secret } = rig.root.auth.secondFactors.beginEnrolment('Test', rig.alice.user.email);
      const bytes = base32Decode(secret);
      const code = bytes ? totpCode(bytes, totpStepOf(Date.now())) : '';
      return rig.root.auth.secondFactors.confirmEnrolment(
        rig.alice.user,
        secret,
        code,
        rig.operator.id,
      );
    },
    writes: { act: 'second-factor-changed', object: 'user', actor: 'operator' },
  },
  'SecondFactorService.reset': {
    kind: 'mutation',
    target: (root) => root.auth.secondFactors,
    prepare: async (rig) => {
      const { secret } = rig.root.auth.secondFactors.beginEnrolment('Test', rig.alice.user.email);
      const bytes = base32Decode(secret);
      const code = bytes ? totpCode(bytes, totpStepOf(Date.now())) : '';
      await rig.root.auth.secondFactors.confirmEnrolment(rig.alice.user, secret, code, 'x');
    },
    drive: async (rig) =>
      rig.root.users.handlers.resetSecondFactor(
        await rig.operatorPost(`/admin/users/${rig.alice.user.id}/reset-second-factor`, {}),
        rig.alice.user.id,
      ),
    writes: { act: 'second-factor-changed', object: 'user', actor: 'operator' },
  },
  'LocalAccountsService.remove': {
    kind: 'mutation',
    target: accounts,
    prepare: localAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.accounts.remove((prepared as LocalAccountRecord).id, rig.operator.id),
    writes: {
      act: 'local-account-removed',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SessionService.createLocalStep': exempt(SESSION_STATE),
  'SessionService.peekLocalStep': exempt(SESSION_STATE),
  'SessionService.takeLocalStep': exempt(SESSION_STATE),
  'SessionService.create': exempt(SESSION_STATE),
  'SessionService.read': READ,
  'SessionService.destroyById': exempt(SESSION_STATE),
  'SessionService.destroy': exempt(SESSION_STATE),
  'SessionService.createPending': exempt(SESSION_STATE),
  'SessionService.takePending': exempt(SESSION_STATE),
  'SessionService.clearPendingCookie': READ,

  // ── users (the caller authorizes: operator only) ──────────────────────────
  'UserAdminService.list': READ,
  'UserAdminService.get': READ,
  'UserAdminService.ensureIdentity': exempt(
    'the user row of an identity the setup names administrator: the act is audited by AdministratorsService.grantUser',
  ),
  'UserAdminService.deactivate': {
    kind: 'mutation',
    target: (root) => root.users.service,
    drive: async (rig) =>
      rig.root.users.handlers.deactivate(
        await rig.operatorPost(`/admin/users/${rig.alice.user.id}/deactivate`, {}),
        rig.alice.user.id,
      ),
    writes: { act: 'user-deactivated', object: 'user', actor: 'operator' },
  },
  'UserAdminService.reactivate': {
    kind: 'mutation',
    target: (root) => root.users.service,
    prepare: (rig) =>
      rig.root.users.service.deactivate(
        { actorId: rig.operator.id, userId: rig.operator.id },
        rig.alice.user.id,
      ),
    drive: async (rig) =>
      rig.root.users.handlers.reactivate(
        await rig.operatorPost(`/admin/users/${rig.alice.user.id}/reactivate`, {}),
        rig.alice.user.id,
      ),
    writes: { act: 'user-reactivated', object: 'user', actor: 'operator' },
  },
  'UserAdminService.endSessions': {
    kind: 'mutation',
    target: (root) => root.users.service,
    drive: async (rig) =>
      rig.root.users.handlers.endSessions(
        await rig.operatorPost(`/admin/users/${rig.alice.user.id}/end-sessions`, {}),
        rig.alice.user.id,
      ),
    writes: { act: 'user-sessions-ended', object: 'user', actor: 'operator' },
  },

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
  // ── instance name (the entry is written by the Administration handler) ───
  'InstanceNameService.isLocked': READ,
  'InstanceNameService.identity': READ,
  'InstanceNameService.setName': {
    kind: 'mutation',
    target: (root) => root.instance.name,
    drive: async (rig) =>
      rig.root.instance.handlers.setName(
        await rig.operatorPost('/api/admin/instance-name', { name: 'Dalae prod' }),
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'instance-name',
      actor: 'operator',
    },
  },
  'PluginStatsReader.statusFor': READ,
  'PluginStatsReader.refresh': exempt(
    'refreshes the cached copy of the public plugin statistics read from the collector: nothing of the instance is created, changed or revoked',
  ),
  'InstanceProfiler.countCall': exempt(
    'counts, in memory, the calls decided since the last telemetry profile: nothing of the instance is stored, changed or revoked',
  ),
  'InstanceProfiler.dayIdFor': exempt(
    'draws, in memory, the telemetry day identifier of a UTC day: never stored, nothing of the instance changes',
  ),
  'InstanceProfiler.profile': READ,
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
  'DelegationService.revokeAllOf': {
    kind: 'mutation',
    target: (root) => root.oauth.delegations,
    prepare: (rig) => rig.delegation(),
    // Reached through the one act that ends every delegation of a user: their deactivation.
    drive: (rig) =>
      rig.root.users.service.deactivate(
        { actorId: rig.operator.id, userId: rig.operator.id },
        rig.alice.user.id,
      ),
    writes: { act: 'delegation-revoked', object: 'delegation', actor: 'operator' },
  },
  'DelegatedTokenVerifier.resolve': READ,
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
    // A delegation rotates only what it issued itself: the mission comes from the door.
    prepare: async (rig) => {
      const connection = await rig.connectByKey();
      const actor = await delegatedActor(rig);
      const issued = await rig.root.management.tools.issueMission(actor, {
        name: 'Read the things',
        connections: [{ connection_id: connection.id, preset: 'reader' }],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`issue refused: ${issued.refusal.code}`);
      return { missionId: issued.data.mission.mission_id, actor };
    },
    drive: (rig, prepared: { missionId: string; actor: ManagementActor }) =>
      rig.root.management.tools.rotateMissionToken(prepared.actor, {
        mission_id: prepared.missionId,
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
      'administrator-granted',
      'administrator-granted',
      'administrator-granted',
      'administrator-granted',
      'administrator-revoked',
      'approval-granted',
      'config-changed',
      'config-changed',
      'config-changed',
      'config-changed',
      'config-changed',
      'connection-created',
      'connection-created',
      'connection-created',
      'connection-created',
      'connection-default-env-set',
      'connection-reassigned',
      'connection-revoked',
      'connection-transferred',
      'delegation-granted',
      'delegation-revoked',
      'delegation-revoked',
      'delegation-revoked',
      'gate-changed',
      'group-created',
      'group-member-added',
      'group-member-removed',
      'invitation-added',
      'invitation-removed',
      'limits-changed',
      'local-account-created',
      'local-account-created',
      'local-account-removed',
      'local-link-created',
      'local-password-changed',
      'local-password-changed',
      'mission-changed',
      'mission-issued',
      'mission-issued',
      'mission-issued',
      'mission-member-added',
      'mission-member-left',
      'mission-member-removed',
      'mission-orphaned',
      'mission-orphaned',
      'mission-restored',
      'mission-revoked',
      'mission-revoked',
      'mission-rotated',
      'mission-rotated',
      'mission-rotated',
      'mission-rotated',
      'mission-token-issued',
      'mission-token-revoked',
      'mission-token-revoked',
      'oauth-client-approved',
      'period-reset',
      'permissions-changed',
      'request-refused',
      'resource-edited',
      'resources-discovered',
      'resources-discovered',
      'second-factor-changed',
      'second-factor-changed',
      'second-factor-waiver-changed',
      'setup-finished',
      'share-created',
      'share-revoked',
      'sign-in-provider-disabled',
      'user-deactivated',
      'user-reactivated',
      'user-sessions-ended',
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
