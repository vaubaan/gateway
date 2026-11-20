/**
 * Structural test (spec §8 "one entry … per administrative act"
 * "every admin mutation path writes an admin audit entry — the test
 * enumerates the service methods").
 *
 * The public methods of every class under `server/{accounts,
 * missions,auth,requests,telemetry,instance,authority,shares,groups,users,vaubaan}` are
 * read from the source with the TypeScript
 * parser and each must be classified below as a read, a mutation or an
 * exemption with its reason. A method added tomorrow fails the first test
 * until it is classified; a mutation is then driven on an ephemeral instance
 * and must leave the administrative entry named next to it.
 */
import { switchOnForTests } from '../../support/auth/testing';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdminAct, AdminObjectType } from '@vaubaan/gateway-core';
import { createRegistry } from '@vaubaan/plugin-sdk';
import vaubaanPlugin, { type VaubaanCaller } from '@vaubaan/plugin-vaubaan';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { budgetMissionOf } from '../../../src/server/budget';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { generateEd25519KeyPair, type Actor } from '../../../src/server/accounts';
import {
  API_KEY_SPEC,
  SSH_KEY_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  seedRegisteredClient,
  stateOf,
} from '../../support/accounts/testing';
import type { IssuedLink } from '../../../src/server/auth';
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import type { SignInAccountRecord } from '../../../src/server/store';
import { VaubaanActs } from '../../../src/server/vaubaan';
import { saveTestOidcSignInProvider } from '../../support/auth/testing';
import { answerAnyDiscovery } from '../auth/fake-idp';
import type {
  AccountRecord,
  GroupRecord,
  MissionRecord,
  UserRecord,
} from '../../../src/server/store/types';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/server');
const SCANNED = [
  'accounts',
  'missions',
  'auth',
  'requests',
  'telemetry',
  'instance',
  'authority',
  'shares',
  'groups',
  'users',
  'vaubaan',
];
const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR_EMAIL = 'ops@example.com';

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

// ── The rig: a real root over fixture plugins and a mocked service ─────────

interface Rig {
  readonly root: GatewayRoot;
  readonly operator: UserRecord;
  readonly alice: Actor;
  /** Same-origin form POST carrying the operator's session. */
  operatorPost(path: string, fields: Record<string, string>): Promise<Request>;
  connectByKey(): Promise<AccountRecord>;
  registerOAuthApp(): Promise<void>;
  issue(): Promise<MissionRecord>;
  /** An open claim on a mission of Alice whose risk has consumed one action. */
  claim(): Promise<string>;
  /** An open approval request on a mission of Alice: a call refused on a risk she gated. */
  approvalRequest(): Promise<string>;
  /** A user who signed in once: the target of a share, a member to add. */
  bob(): Promise<UserRecord>;
  /**
   * A mission of Alice on an account owned by a local group she belongs to: her
   * authority there is that membership, which a test removes or returns.
   */
  groupGrounded(): Promise<{ mission: MissionRecord; group: GroupRecord }>;
  /** An account of Alice, transferred to a local group that then lost its only member. */
  ownerless(): Promise<AccountRecord>;
  /**
   * Alice's platform management mission on her Vaubaan account, as the `vaubaan`
   * plugin's ports receive its calls (ADR platform-management-is-a-plugin-on-the-execution-door).
   */
  platformCaller(): Promise<VaubaanCaller>;
}

async function openRig(): Promise<Rig> {
  const service = mockFetch([
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
            { service: 'keyco', ref: 'acct-a', displayName: 'Account A' },
          ],
        }),
        fixturePlugin({
          id: 'sshco',
          credential: SSH_KEY_SPEC,
          discoverResources: async () => [
            { service: 'sshco', ref: 'vps.example.com', displayName: 'VPS' },
          ],
        }),
        fixturePlugin({ id: 'oauthco', credential: OAUTH_SPEC }),
        vaubaanPlugin,
      ]),
    serviceFetch: service,
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
      const started = await root.accounts.service.start(alice, 'keyco', {
        displayName: 'Key account',
        fields: { token: 'key-0123456789', team_id: 'team_abc' },
      });
      if (started.kind !== 'connected') throw new Error('expected an immediate account');
      return started.account;
    },
    async registerOAuthApp() {
      // The client the gateway would have registered at the service (not what is audited here).
      await seedRegisteredClient(root.store.config, {
        serviceId: 'oauthco',
        clientId: 'cid',
        clientSecret: 'csecret',
        redirectUri: root.accounts.service.callbackUrl('oauthco').href,
        at: new Date(),
      });
    },
    async issue() {
      const account = await rig.connectByKey();
      const result = await root.missions.service.issue(alice.user, {
        name: 'Read the things',
        accounts: [{ account_id: account.id, trust_levels: { read: 'careful' } }],
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
      const [carried] = mission.accounts;
      if (!carried) throw new Error('expected an account');
      const group = await root.store.groups.getOrCreate('mission-owners', 'local', null);
      await root.store.groups.addMember(group.id, aliceUser.id);
      await root.store.accounts.transferOwner(carried.accountId, {
        kind: 'group',
        id: group.id,
      });
      return { mission, group };
    },
    async ownerless() {
      const account = await rig.connectByKey();
      const group = await root.store.groups.getOrCreate('key-admins', 'local', null);
      await root.store.groups.addMember(group.id, aliceUser.id);
      await root.store.accounts.transferOwner(account.id, { kind: 'group', id: group.id });
      await root.store.groups.removeMember(group.id, aliceUser.id);
      const [unowned] = await root.store.accounts.markOwnerlessUnowned();
      if (!unowned) throw new Error('expected the account to lose its owner');
      return unowned;
    },
    async platformCaller() {
      const started = await root.accounts.service.start(alice, 'vaubaan');
      if (started.kind !== 'connected') throw new Error('expected a host account at once');
      const issued = await root.missions.service.issue(alice.user, {
        name: 'Platform management',
        accounts: [
          {
            account_id: started.account.id,
            trust_levels: {
              read: 'careful',
              prepare: 'careful',
              rotate: 'careful',
              stop: 'careful',
            },
          },
        ],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`platform mission refused: ${issued.reason}`);
      return { missionId: issued.mission.id, userId: aliceUser.id, holderUserId: aliceUser.id };
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
   * The act comes through the `vaubaan` plugin: the entry also names the
   * calling mission (spec §8). Absent: the entry names none.
   */
  readonly viaMission?: true;
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

const accounts = (root: GatewayRoot) => root.accounts.service;
const signInAccounts = (root: GatewayRoot) => root.auth.signInAccounts;
const LOCAL_OBJECT = 'sign-in-account:local';
const LOCAL_PASSWORD = 'a sentence long enough';

/** A service of kind `local`, added as Settings would. */
async function localService(rig: Rig): Promise<void> {
  await rig.root.auth.signInProviders.save(
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

/** The service and one account, created by the operator. */
async function signInAccount(rig: Rig): Promise<SignInAccountRecord> {
  await localService(rig);
  return rig.root.auth.signInAccounts.createSignInAccount({
    signInProviderId: 'local',
    email: 'local@example.com',
    password: LOCAL_PASSWORD,
    actor: rig.operator.id,
  });
}
const missions = (root: GatewayRoot) => root.missions.service;
/** The acts behind the ports: the instance the root built shares this prototype. */
const vaubaanActs = () => VaubaanActs.prototype;
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

const RULES: Readonly<Record<string, Rule>> = {
  // ── accounts ───────────────────────────────────────────────────────────
  'AccountService.services': READ,
  'AccountService.service': READ,
  'AccountService.listFor': READ,
  'AccountService.get': READ,
  'AccountService.defaultEnvChoices': READ,
  'AccountService.setDefaultEnv': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, account: AccountRecord) =>
      rig.root.accounts.service.setDefaultEnv(rig.alice, account.id, 'staging'),
    writes: { act: 'account-default-env-set', object: 'account', actor: 'alice' },
  },
  'AccountService.callbackUrl': READ,
  'AccountService.start': {
    kind: 'mutation',
    target: accounts,
    drive: (rig) => rig.connectByKey(),
    writes: { act: 'account-created', object: 'account', actor: 'alice' },
  },
  'AccountService.importPastedKey': {
    kind: 'mutation',
    target: accounts,
    drive: (rig) =>
      rig.root.accounts.service.importPastedKey(rig.alice, 'keyco', {
        displayName: 'Imported key',
        fields: { token: 'key-0123456789', team_id: 'team_abc' },
        importedFrom: { system: 'vaubaan-v4', org: 'acme', source: 'service_admins/1' },
      }),
    writes: { act: 'account-created', object: 'account', actor: 'alice' },
  },
  'AccountService.importSshKey': {
    kind: 'mutation',
    target: accounts,
    drive: (rig) =>
      rig.root.accounts.service.importSshKey(rig.alice, {
        serviceId: 'sshco',
        displayName: 'vps',
        fields: { host: 'vps.example.com', user: 'dev' },
        keyPair: generateEd25519KeyPair('v4'),
        importedFrom: { system: 'vaubaan-v4', org: 'acme', source: 'ssh_bindings/acme/vps' },
      }),
    writes: { act: 'account-created', object: 'account', actor: 'alice' },
  },
  'AccountService.complete': {
    kind: 'mutation',
    target: accounts,
    prepare: async (rig) => {
      await rig.registerOAuthApp();
      const started = await rig.root.accounts.service.start(rig.alice, 'oauthco');
      if (started.kind !== 'redirect') throw new Error('expected a redirect');
      return stateOf(started.url);
    },
    drive: (rig, state: string) =>
      rig.root.accounts.service.complete(
        rig.alice,
        'oauthco',
        new URLSearchParams({ code: 'code-1', state }),
      ),
    writes: { act: 'account-created', object: 'account', actor: 'alice' },
  },
  'AccountService.discover': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, account: AccountRecord) =>
      rig.root.accounts.service.discover(rig.alice, account.id),
    writes: { act: 'resources-discovered', object: 'account', actor: 'alice' },
  },
  // The gateway's own discovery after a call that created a resource (ADR
  // created-resources-join-the-mission): one entry per scheduled discovery,
  // written once its attempts are over; the actor is the human behind the key.
  'AccountService.auditDiscoveryAfterCall': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.connectByKey(),
    drive: async (rig, account: AccountRecord) => {
      const cause = { missionId: 'mis_after_call', tool: 'keyco__create_thing' };
      const outcome = await rig.root.accounts.service.discoverAfterCall(account.id, cause);
      if (!outcome) throw new Error('expected the account to serve');
      return rig.root.accounts.service.auditDiscoveryAfterCall(
        account.id,
        { ...cause, userId: rig.alice.user.id },
        { ...outcome, attempts: 1 },
      );
    },
    writes: { act: 'resources-discovered', object: 'account', actor: 'alice' },
  },
  'AccountService.discoverAfterCall': exempt(
    'one attempt of the discovery DiscoveryAfterCall runs after a creating call; the scheduler audits its outcome once, through AccountService.auditDiscoveryAfterCall (resources-discovered, cause after-a-call)',
  ),
  'DiscoveryAfterCall.afterCall': exempt(
    'the execution door hook: it only schedules; the discovery it schedules is audited through AccountService.auditDiscoveryAfterCall',
  ),
  'DiscoveryAfterCall.schedule': exempt(
    'queues a discovery for later; the discovery, once run, is audited through AccountService.auditDiscoveryAfterCall',
  ),
  'DiscoveryAfterCall.idle': READ,
  'DiscoveryAfterCall.stop': exempt(
    'the shutdown of the process (root.close): it schedules nothing more and waits for the discovery in flight, which audits itself',
  ),
  // "Check now" on a mission card: the creator (or an owner) runs the discovery.
  'AccountService.checkForMission': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.issue(),
    drive: (rig, mission: MissionRecord) =>
      rig.root.accounts.service.checkForMission(
        rig.alice,
        mission.id,
        mission.accounts[0]!.accountId,
      ),
    writes: { act: 'resources-discovered', object: 'account', actor: 'alice' },
  },
  'AccountService.refreshOnItsOwn': exempt(
    'the refresh the gateway runs on its own (hourly, or a page showing the account stale), no human actor: it writes one resources-discovered entry (actor `discovery`, cause scheduled / on-open) only when it changed something, and none for a no-op (tests/integration/accounts/auto-refresh.test.ts)',
  ),
  'FutureResources.snapshot': READ,
  'FutureResources.settle': exempt(
    'runs after an act that is audited itself (a discovery, a relabel, a default environment, a created resource) and writes one mission-resource-joined / mission-resource-left entry per move (tests/integration/accounts/future-resources.test.ts)',
  ),
  'AccountRefresher.start': exempt('arms the tick of the automatic refresh at boot'),
  'AccountRefresher.stop': exempt(
    'the shutdown of the process (root.close): waits for the refreshes in progress',
  ),
  'AccountRefresher.runOnce': exempt(
    'one tick of the hourly refresh: each refresh goes through AccountService.refreshOnItsOwn',
  ),
  'AccountRefresher.refreshStale': exempt(
    'a page asks for the stale accounts it shows: each refresh goes through AccountService.refreshOnItsOwn',
  ),
  'AccountRefresher.staleAmong': READ,
  'AccountRefresher.staleIds': READ,
  'AccountService.updateResource': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.connectByKey(),
    drive: async (rig, account: AccountRecord) => {
      const [resource] = await rig.root.store.accounts.listResources(account.id);
      if (!resource) throw new Error('expected a discovered resource');
      return rig.root.accounts.service.updateResource(rig.alice, account.id, resource.id, {
        displayName: 'Renamed',
        env: 'prod',
        hidden: true,
      });
    },
    writes: { act: 'resource-edited', object: 'account', actor: 'alice' },
  },
  'AccountService.revoke': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, account: AccountRecord) => rig.root.accounts.service.revoke(rig.alice, account.id),
    writes: { act: 'account-revoked', object: 'account', actor: 'alice' },
  },
  'AccountService.transferTargets': READ,
  'AccountService.serviceGrantOf': READ,
  'AccountService.listOwnerless': READ,
  'AccountService.reassignTargets': READ,
  'AccountService.transfer': {
    kind: 'mutation',
    target: accounts,
    prepare: async (rig) => {
      const account = await rig.connectByKey();
      const group = await rig.root.store.groups.getOrCreate('key-admins', 'local', null);
      await rig.root.store.groups.addMember(group.id, rig.alice.user.id);
      return { account, group };
    },
    drive: (rig, prepared: { account: AccountRecord; group: GroupRecord }) =>
      rig.root.accounts.service.transfer(
        { user: rig.alice.user, groups: [prepared.group] },
        prepared.account.id,
        prepared.group.id,
      ),
    writes: { act: 'account-transferred', object: 'account', actor: 'alice' },
  },
  'AccountService.reassign': {
    kind: 'mutation',
    target: accounts,
    prepare: (rig) => rig.ownerless(),
    drive: (rig, account: AccountRecord) =>
      rig.root.accounts.service.reassign(rig.operator.id, account.id, {
        kind: 'user',
        email: rig.alice.user.email,
      }),
    writes: { act: 'account-reassigned', object: 'account', actor: 'operator' },
  },
  'CredentialBroker.resolve': READ,
  'CredentialBroker.contextOf': READ,
  'CredentialBroker.forRevocation': READ,
  'CredentialBroker.withdrawAtService': exempt(
    'a step of AccountService.revoke, whose account-revoked entry carries what the service answered (after.service_grant); it writes nothing in the store itself',
  ),
  'CredentialBroker.refresh': exempt(SYSTEM_REFRESH),
  'OAuth2Clients.forTokenRequest': READ,
  'OAuth2Clients.forAuthorization': exempt(
    "registers the instance's own OAuth client at a service that accepts dynamic registration, as a step of a person's connect (ADR oauth-client-registered-by-the-gateway): nobody chose it, and the account-created entry follows; the instance log names the service and the client id",
  ),
  'OAuth2Clients.rejected': exempt(
    'forgets a registered client the service refused (invalid_client), during an exchange or a refresh, with no human act: the next connect registers again; the instance log says so',
  ),
  'OAuthBrokers.forProvider': READ,
  'OAuthBrokers.byName': READ,
  'OAuthBrokerClient.startFlow': exempt(
    "asks the OAuth broker to start a person's connect (ADR google-calendar-through-an-oauth-broker): nothing is written in the store; the account-created entry follows",
  ),
  'OAuthBrokerClient.redeem': exempt(
    'a step of a person’s connect: the grant redeemed at the broker becomes the credential of the account-created (or account-reconnected) entry',
  ),
  'OAuthBrokerClient.token': exempt(SYSTEM_REFRESH),
  'OAuthBrokerClient.revoke': exempt(
    'a step of AccountService.revoke, whose account-revoked entry carries what the broker answered (after.service_grant)',
  ),
  'AttestationVerifier.verify': READ,
  'AttestedChannel.send': exempt(
    'carries a broker call over a pinned TLS connection, attesting the broker first when no pin is in force (ADR oauth-broker-stateless-in-an-attested-enclave D6): the pin lives in memory, nothing is written in the store; the act it carries is classified on OAuthBrokerClient',
  ),
  'FetchChannel.send': exempt(
    'carries a broker call to a broker declared attestation: none; nothing is written in the store; the act it carries is classified on OAuthBrokerClient',
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
    'authentication of a call, not an administrative act: it reads the token, its mission and its holder, and writes nothing',
  ),
  'MissionService.list': READ,
  'MissionService.get': READ,
  'MissionService.access': READ,
  'MissionService.ownMission': READ,
  'MissionService.ownInspected': READ,
  'MissionService.activeMissionCeiling': READ,
  'MissionService.risksOf': READ,
  // The bodies of MissionService's edit acts (mission-edits.ts), each classified on the service.
  'MissionEdits.editView': exempt('the body of MissionService.editView, classified there'),
  'MissionEdits.previewEdit': exempt('the body of MissionService.previewEdit, classified there'),
  'MissionEdits.edit': exempt('the body of MissionService.edit, classified there'),
  'MissionEdits.history': exempt('the body of MissionService.history, classified there'),
  'MissionEdits.restore': exempt('the body of MissionService.restore, classified there'),
  'MissionService.stateOf': READ,
  'MissionService.standing': READ,
  'MissionService.stateAfterRefusal': READ,
  'MissionService.kitOf': READ,
  'MissionService.issue': {
    kind: 'mutation',
    target: missions,
    // The account is made first so that its own entry is not the one counted.
    prepare: (rig) => rig.connectByKey(),
    drive: (rig, account: AccountRecord) =>
      rig.root.missions.service.issue(rig.alice.user, {
        name: 'Read the things',
        accounts: [{ account_id: account.id, trust_levels: { read: 'careful' } }],
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
  'MissionService.onAccount': READ,
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
  'MissionService.trustRaisesFor': READ,
  'MissionService.trustRaiseOffer': READ,
  'MissionService.snoozeTrustRaise': exempt(
    'puts off a trust-raise offer on the creator’s own screens (risk model §4.7): nothing the mission allows moves, and a raise itself is an audited edit',
  ),
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
  'MissionService.history': READ,
  // Restoring version 1 after a rename: an edit, audited as one.
  'MissionService.restore': {
    kind: 'mutation',
    target: missions,
    prepare: async (rig) => {
      const mission = await rig.issue();
      const view = await rig.root.missions.service.editView(rig.alice.user, mission.id);
      await rig.root.missions.service.edit(rig.alice.user, mission.id, {
        draft: { ...view?.draft, name: `${mission.name} (edited)` },
        revision: view?.revision,
      });
      return mission;
    },
    drive: (rig, mission: MissionRecord) =>
      rig.root.missions.service.restore(rig.alice.user, mission.id, 1),
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
  'AccountAuthorityService.authorityOf': READ,
  'AccountAuthorityService.accountsOf': READ,
  'AccountAuthorityService.gapsOf': READ,
  'MissionGrounds.check': READ,
  // `orphaned` is derived on every read and never stored (spec §2.3): the door's own
  // detection (`inspect`) and every reader's (`derive`) write nothing at all, in either
  // direction. Only a watch around a human act writes, and it names that human.
  'MissionGrounds.inspect': READ,
  'MissionGrounds.derive': READ,
  // What a share would restore, asked before it is made: nothing is written.
  'MissionGrounds.forecastShare': READ,
  'MissionGrounds.watchAccount': {
    kind: 'mutation',
    target: (root) => root.authority.grounds,
    prepare: (rig) => rig.issue(),
    // The act: the account is revoked. Loss of authority → `mission-orphaned`.
    drive: async (rig, mission: MissionRecord) => {
      const accountId = mission.accounts[0]?.accountId ?? '';
      const watch = await rig.root.authority.grounds.watchAccount(accountId);
      await rig.root.store.accounts.revoke(accountId);
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
    drive: (rig, account: AccountRecord) =>
      rig.root.shares.service.share(rig.alice, account.id, {
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
      const account = await rig.connectByKey();
      const { share } = await rig.root.shares.service.share(rig.alice, account.id, {
        target: { kind: 'user', email: 'bob@example.com' },
        riskIds: ['keyco.read-things'],
      });
      return { shareId: share.id, accountId: account.id };
    },
    drive: (rig, { shareId, accountId }: { shareId: string; accountId: string }) =>
      rig.root.shares.service.revoke(rig.alice, shareId, accountId),
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
  'SignInProvidersService.views': READ,
  'SignInProvidersService.view': READ,
  'SignInProvidersService.resolve': READ,
  'SignInProvidersService.ofIssuer': READ,
  'SignInProvidersService.isReadOnly': READ,
  'SignInProvidersService.state': READ,
  'SignInProvidersService.setWaiver': {
    kind: 'mutation',
    target: (root) => root.auth.signInProviders,
    prepare: (rig) =>
      saveTestOidcSignInProvider(rig.root.store.config, {
        issuer: 'https://idp.example.com',
        clientId: 'c',
        clientSecret: 's',
      }),
    drive: async (rig) =>
      rig.root.auth.handlers.setSecondFactorWaiver(
        await rig.operatorPost('/api/admin/sign-in-providers/idp/waiver', { waiver: 'amr' }),
        'idp',
      ),
    writes: {
      act: 'second-factor-waiver-changed',
      object: 'instance-config',
      objectId: 'sign-in:idp',
      actor: 'operator',
    },
  },
  'SignInProvidersService.recordTest': exempt(
    'the outcome of a test beside the session, recorded by the handler that writes its `sign-in-provider-tested` entry (tests/integration/auth/service-test.test.ts)',
  ),
  'SignInProvidersService.setEnabled': {
    kind: 'mutation',
    target: (root) => root.auth.signInProviders,
    prepare: async (rig) => {
      await rig.root.auth.signInProviders.save(
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
    'the backup command writes it into its copy of the store, never into the live store: nobody acts on this instance (docs/handbook/authentication.md)',
  ),
  'SignInProvidersService.save': {
    kind: 'mutation',
    target: (root) => root.auth.signInProviders,
    drive: async (rig) =>
      rig.root.auth.handlers.saveIdpSettings(
        await rig.operatorPost('/api/admin/sign-in-providers', {
          mode: 'create',
          sign_in_provider_id: 'github',
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
    target: (root) => root.auth.signInProviders,
    prepare: (rig) =>
      rig.root.auth.signInProviders.save(
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
    // an administrator with a way in exists (a sign-in account named by the setup).
    prepare: async (rig) => {
      await localService(rig);
      const account = await rig.root.auth.signInAccounts.createSignInAccount({
        signInProviderId: 'local',
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
  'AdministratorsService.signInProviderIdOf': READ,
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
      saveTestOidcSignInProvider(rig.root.store.config, {
        issuer: 'https://idp.example.com',
        clientId: 'c',
        clientSecret: 's',
      }),
    drive: async (rig) =>
      rig.root.users.handlers.addAdministratorGroup(
        await rig.operatorPost('/admin/users/administrators/group', {
          sign_in_provider: 'idp',
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
  // Sign-in accounts (ADR local-accounts-sign-in-provider): the service audits what an
  // administrator or a link does; a person's own sign-in (the password, the second
  // factor) writes counters and spends codes but is no administrative act.
  'SignInAccountsService.linkUrl': READ,
  'SignInAccountsService.inspectLink': READ,
  'SignInAccountsService.signInAccountOf': READ,
  'SignInAccountsService.signInAccountById': READ,
  'SignInAccountsService.list': READ,
  'SignInAccountsService.pendingLinks': READ,
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
    'run by the boot alone: moves the factors sign-in accounts kept to their people, a change of storage and of nobody’s authority (tests/integration/auth/second-factor.test.ts)',
  ),
  'SignInAccountsService.checkPassword': exempt(
    'the person’s own sign-in: counts a wrong password towards the lockout and clears the count on a right one; refusals are logged, not audited (spec §8 names a human actor)',
  ),
  'SecondFactorService.check': exempt(
    'the person’s own sign-in: advances the accepted time step or spends a recovery code; a sign-in by recovery code is logged',
  ),
  'SignInAccountsService.createLink': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: signInAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.signInAccounts.createLink({
        kind: 'reset',
        signInProviderId: 'local',
        email: (prepared as SignInAccountRecord).email,
        createdBy: rig.operator.id,
      }),
    writes: {
      act: 'local-link-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SignInAccountsService.createSignInAccount': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: localService,
    drive: (rig) =>
      rig.root.auth.signInAccounts.createSignInAccount({
        signInProviderId: 'local',
        email: 'fresh@example.com',
        password: LOCAL_PASSWORD,
        actor: rig.operator.id,
      }),
    writes: {
      act: 'sign-in-account-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SignInAccountsService.createSignInAccountFromLink': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: async (rig) => {
      await localService(rig);
      return rig.root.auth.signInAccounts.createLink({
        kind: 'invite',
        signInProviderId: 'local',
        email: 'invited@example.com',
        createdBy: rig.operator.id,
      });
    },
    drive: (rig, prepared: never) =>
      rig.root.auth.signInAccounts.createSignInAccountFromLink(
        (prepared as IssuedLink).token,
        LOCAL_PASSWORD,
      ),
    writes: {
      act: 'sign-in-account-created',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SignInAccountsService.resetPasswordFromLink': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: async (rig) => {
      const account = await signInAccount(rig);
      return rig.root.auth.signInAccounts.createLink({
        kind: 'reset',
        signInProviderId: 'local',
        email: account.email,
        createdBy: rig.operator.id,
      });
    },
    drive: (rig, prepared: never) =>
      rig.root.auth.signInAccounts.resetPasswordFromLink(
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
  'SignInAccountsService.changePassword': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: signInAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.signInAccounts.changePassword(
        (prepared as SignInAccountRecord).id,
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
  'SignInAccountsService.remove': {
    kind: 'mutation',
    target: signInAccounts,
    prepare: signInAccount,
    drive: (rig, prepared: never) =>
      rig.root.auth.signInAccounts.remove((prepared as SignInAccountRecord).id, rig.operator.id),
    writes: {
      act: 'sign-in-account-removed',
      object: 'instance-config',
      objectId: LOCAL_OBJECT,
      actor: 'operator',
    },
  },
  'SessionService.createLocalStep': exempt(SESSION_STATE),
  'SessionService.reissueLocalStep': exempt(SESSION_STATE),
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
  // Reads the count of users against its ceiling; throws, writes nothing.
  'UserAdminService.refuseNewUser': READ,
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
  'InstanceIdentifier.peek': READ,
  'InstanceIdentifier.current': exempt(
    'draws and stores the telemetry instance identifier the first time a profile needs one: no administrator acted, and the identifier leaves only if usage statistics are on',
  ),
  'InstanceIdentifier.regenerate': {
    kind: 'mutation',
    target: (root) => root.telemetry.instanceId,
    drive: async (rig) =>
      rig.root.telemetry.handlers.regenerateInstanceId(
        await rig.operatorPost('/api/admin/telemetry/instance-id', {}),
      ),
    writes: {
      act: 'config-changed',
      object: 'instance-config',
      objectId: 'telemetry-instance-id',
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
        await rig.operatorPost('/api/admin/instance-name', { name: 'Acme prod' }),
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
  'InstanceProfiler.profile': READ,
  // ── the `vaubaan` plugin: an agent acting for the user, through a mission ──
  'VaubaanActs.listMyAccounts': READ,
  'VaubaanActs.getCatalog': READ,
  'VaubaanActs.listMyMissions': READ,
  'VaubaanActs.previewPolicy': READ,
  'VaubaanActs.issueMission': {
    kind: 'mutation',
    target: vaubaanActs,
    prepare: async (rig) => ({
      account: await rig.connectByKey(),
      caller: await rig.platformCaller(),
    }),
    drive: (rig, prepared: { account: AccountRecord; caller: VaubaanCaller }) =>
      rig.root.vaubaan.ports.issueMission(prepared.caller, {
        name: 'Read the things',
        accounts: [{ account_id: prepared.account.id, trust_levels: { read: 'careful' } }],
        period: { kind: 'one-off' },
        expires_at: null,
      }),
    writes: { act: 'mission-issued', object: 'mission', actor: 'alice', viaMission: true },
  },
  'VaubaanActs.renameMission': {
    kind: 'mutation',
    target: vaubaanActs,
    prepare: async (rig) => ({ mission: await rig.issue(), caller: await rig.platformCaller() }),
    drive: (rig, prepared: { mission: MissionRecord; caller: VaubaanCaller }) =>
      rig.root.vaubaan.ports.renameMission(prepared.caller, {
        mission_id: prepared.mission.id,
        name: 'Renamed by an agent',
      }),
    writes: { act: 'mission-changed', object: 'mission', actor: 'alice', viaMission: true },
  },
  'VaubaanActs.editMission': {
    kind: 'mutation',
    target: vaubaanActs,
    // The draft an agent edits is the stored one, as `list_my_missions` answers it.
    prepare: async (rig) => {
      const mission = await rig.issue();
      const caller = await rig.platformCaller();
      const view = await rig.root.missions.service.editView({ id: caller.userId }, mission.id);
      if (!view) throw new Error('no edit view for the creator');
      return { mission, caller, draft: view.draft };
    },
    drive: (
      rig,
      prepared: { mission: MissionRecord; caller: VaubaanCaller; draft: Record<string, unknown> },
    ) =>
      rig.root.vaubaan.ports.editMission(prepared.caller, {
        ...prepared.draft,
        name: 'Edited by an agent',
        mission_id: prepared.mission.id,
      }),
    writes: { act: 'mission-changed', object: 'mission', actor: 'alice', viaMission: true },
  },
  'VaubaanActs.rotateMissionToken': {
    kind: 'mutation',
    target: vaubaanActs,
    // A mission rotates only what it issued itself: the mission comes from the plugin.
    prepare: async (rig) => {
      const account = await rig.connectByKey();
      const caller = await rig.platformCaller();
      const issued = await rig.root.vaubaan.ports.issueMission(caller, {
        name: 'Read the things',
        accounts: [{ account_id: account.id, trust_levels: { read: 'careful' } }],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`issue refused: ${issued.refusal.code}`);
      const data = issued.data as { mission: { mission_id: string } };
      return { missionId: data.mission.mission_id, caller };
    },
    drive: (rig, prepared: { missionId: string; caller: VaubaanCaller }) =>
      rig.root.vaubaan.ports.rotateMissionToken(prepared.caller, {
        mission_id: prepared.missionId,
      }),
    writes: { act: 'mission-rotated', object: 'mission', actor: 'alice', viaMission: true },
  },
  // Read: the plugins of the instance; nothing changes.
  'VaubaanPluginActs.pluginStatus': READ,
  'VaubaanPluginActs.uploadPlugin': exempt(
    'writes `plugin-uploaded` through the install service (tests/integration/plugins); the rig keeps its store in memory, where nothing is installed',
  ),
  'VaubaanActs.revokeMission': {
    kind: 'mutation',
    target: vaubaanActs,
    prepare: async (rig) => ({ mission: await rig.issue(), caller: await rig.platformCaller() }),
    drive: (rig, prepared: { mission: MissionRecord; caller: VaubaanCaller }) =>
      rig.root.vaubaan.ports.revokeMission(prepared.caller, { mission_id: prepared.mission.id }),
    writes: { act: 'mission-revoked', object: 'mission', actor: 'alice', viaMission: true },
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
      'account-created',
      'account-created',
      'account-created',
      'account-created',
      'account-default-env-set',
      'account-reassigned',
      'account-revoked',
      'account-transferred',
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
      'gate-changed',
      'group-created',
      'group-member-added',
      'group-member-removed',
      'invitation-added',
      'invitation-removed',
      'limits-changed',
      'local-link-created',
      'local-password-changed',
      'local-password-changed',
      'mission-changed',
      'mission-changed',
      'mission-changed',
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
      'period-reset',
      'permissions-changed',
      'request-refused',
      'resource-edited',
      'resources-discovered',
      'resources-discovered',
      'resources-discovered',
      'second-factor-changed',
      'second-factor-changed',
      'second-factor-waiver-changed',
      'setup-finished',
      'share-created',
      'share-revoked',
      'sign-in-account-created',
      'sign-in-account-created',
      'sign-in-account-removed',
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
    if (rule.writes.viaMission) {
      expect(entry?.via_mission_id, name).toBe(
        (prepared as { caller: VaubaanCaller }).caller.missionId,
      );
    } else if (rule.writes.act.startsWith('mission-')) {
      // An act of the interface names no calling mission.
      expect(entry?.via_mission_id ?? null, name).toBeNull();
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
    const account = await rig.connectByKey();
    const [resource] = await root.store.accounts.listResources(account.id);
    if (!resource) throw new Error('expected a discovered resource');
    const edits = async () =>
      (await root.store.audit.list({ kind: 'admin' })).filter(
        (e) => e.kind === 'admin' && e.act === 'resource-edited',
      );

    await root.accounts.service.updateResource(alice, account.id, resource.id, {
      env: 'staging',
      hidden: true,
    });
    expect(await edits()).toMatchObject([
      {
        object: { type: 'account', id: account.id },
        before: { resource_id: resource.id, ref: 'acct-a', env: null, hidden: false },
        after: { resource_id: resource.id, ref: 'acct-a', env: 'staging', hidden: true },
      },
    ]);

    await root.accounts.service.updateResource(alice, account.id, resource.id, {
      env: 'staging',
      hidden: true,
    });
    expect(await edits()).toHaveLength(1);
  });

  it('a discovery that fails is recorded too, with the reason', async () => {
    rig = await openRig();
    const { root, alice } = rig;
    const account = await rig.connectByKey();
    await root.store.accounts.revoke(account.id);
    const reconnectable = await root.store.accounts.create({
      service: 'keyco',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'No credential',
      credential: null,
    });

    const outcome = await root.accounts.service.discover(alice, reconnectable.id);
    expect(outcome.ok).toBe(false);
    const entry = (await root.store.audit.list({ kind: 'admin' })).at(-1);
    expect(entry).toMatchObject({
      act: 'resources-discovered',
      object: { type: 'account', id: reconnectable.id },
      after: { ok: false, count: 0, error: outcome.error },
    });
  });
});
