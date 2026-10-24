/**
 * Test helpers for the store. Not for production: `StubEncryptor` is NOT encryption, it
 * only reproduces the contract of the crypto module's `Encryptor` (associated-data
 * binding, key version) so repository tests can assert it without a master key.
 */

import { createHash } from 'node:crypto';
import { SetCatalogIndex } from './catalog-index.ts';
import { ManualClock } from './clock.ts';
import type { EncryptedBlob, Encryptor } from './encryptor.ts';
import { InvariantError } from './errors.ts';
import { openMemoryStore, type Store } from './index.ts';
import type { TokenToIssue } from './repositories/delegations.ts';
import type {
  ApprovalRecord,
  GroupRecord,
  RefreshTokenRecord,
  RequestRecord,
  RiskId,
} from './types.ts';

const TAG_BYTES = 8;

export class StubEncryptor implements Encryptor {
  readonly sealCalls: { associatedData: string }[] = [];

  constructor(readonly currentKeyVersion: number = 1) {}

  async encrypt(associatedData: string, plaintext: string): Promise<EncryptedBlob> {
    this.sealCalls.push({ associatedData });
    return {
      keyVersion: this.currentKeyVersion,
      blob: Buffer.concat([
        this.tag(associatedData, this.currentKeyVersion),
        Buffer.from(plaintext, 'utf8'),
      ]),
    };
  }

  async decrypt(associatedData: string, sealed: EncryptedBlob): Promise<string> {
    const blob = Buffer.from(sealed.blob);
    const expected = this.tag(associatedData, sealed.keyVersion);
    if (blob.length < TAG_BYTES || !blob.subarray(0, TAG_BYTES).equals(expected)) {
      throw new Error('StubEncryptor: associated data mismatch');
    }
    return blob.subarray(TAG_BYTES).toString('utf8');
  }

  private tag(associatedData: string, keyVersion: number): Buffer {
    return createHash('sha256')
      .update(`v${keyVersion}:${associatedData}`)
      .digest()
      .subarray(0, TAG_BYTES);
  }
}

/** A small catalog every store test can rely on. */
export const TEST_RISK_IDS: readonly RiskId[] = [
  'github.code-read',
  'github.write-feature-branch',
  'github.merge-protected',
  'supabase[prod].bulk-row-write',
  'supabase[staging].bulk-row-write',
];

export interface TestStoreOptions {
  readonly riskIds?: readonly RiskId[];
  readonly clock?: ManualClock;
  readonly encryptor?: StubEncryptor;
}

export interface TestStore {
  readonly store: Store;
  readonly clock: ManualClock;
  readonly encryptor: StubEncryptor;
}

export function openTestStore(options: TestStoreOptions = {}): TestStore {
  const clock = options.clock ?? new ManualClock();
  const encryptor = options.encryptor ?? new StubEncryptor();
  const store = openMemoryStore({
    encryptor,
    catalog: new SetCatalogIndex(options.riskIds ?? TEST_RISK_IDS),
    clock,
  });
  return { store, clock, encryptor };
}

/**
 * Grants an open approval request the way production does (`RequestService`, resolution
 * `grant`): the approval is written inside the transaction that decides the request, so
 * the request is `granted`, its sealed arguments are erased and its approval exists, or
 * nothing happened.
 */
export async function grantApprovalRequest(
  store: Pick<Store, 'requests'>,
  requestId: string,
  decidedByUserId: string,
  approvalExpiresAt: string,
): Promise<ApprovalRecord> {
  const result = await store.requests.decideApproval(requestId, decidedByUserId, (ctx) => {
    const approval = ctx.createApproval(approvalExpiresAt);
    return {
      state: 'granted' as const,
      decision: {
        resolution: 'grant',
        approval_id: approval.id,
        approval_expires_at: approval.expiresAt,
      },
      approval,
    };
  });
  if (result.status !== 'decided') {
    throw new InvariantError(`request ${requestId} was not open: nothing was granted`);
  }
  return result.outcome.approval;
}

/**
 * Refuses an open request through the decision primitive of its kind (`decideClaim` or
 * `decideApproval`), with the decision production stores for a refusal.
 */
export async function refuseRequest(
  store: Pick<Store, 'requests'>,
  requestId: string,
  decidedByUserId: string,
): Promise<RequestRecord> {
  const request = await store.requests.getById(requestId);
  if (!request) throw new InvariantError(`request ${requestId} does not exist`);
  const refuse = () => ({ state: 'refused' as const, decision: { resolution: 'refuse' } });
  const result =
    request.kind === 'claim'
      ? await store.requests.decideClaim(requestId, decidedByUserId, refuse)
      : await store.requests.decideApproval(requestId, decidedByUserId, refuse);
  if (result.status !== 'decided') {
    throw new InvariantError(`request ${requestId} was not open: nothing was refused`);
  }
  return result.request;
}

/**
 * The first refresh token of a delegation, issued the way production does: the
 * authorization-code grant (`createCode`, then `redeemCode`), which also spends a code
 * and writes the first access token. The code is `code:<refresh hash>`; the access token
 * is `access` or, by default, `access:<refresh hash>` with the refresh token's expiry.
 */
export async function issueFirstRefreshToken(
  store: Pick<Store, 'delegations'>,
  delegationId: string,
  refresh: TokenToIssue,
  access: TokenToIssue = {
    tokenHash: `access:${refresh.tokenHash}`,
    expiresAt: refresh.expiresAt,
  },
): Promise<RefreshTokenRecord> {
  const codeHash = `code:${refresh.tokenHash}`;
  await store.delegations.createCode({
    delegationId,
    codeHash,
    redirectUri: 'http://127.0.0.1/callback',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    expiresAt: refresh.expiresAt,
  });
  const redeemed = await store.delegations.redeemCode(codeHash, () => null, { refresh, access });
  const found = await store.delegations.findRefreshToken(refresh.tokenHash);
  if (redeemed.outcome !== 'issued' || !found) {
    throw new InvariantError(`the code grant of ${delegationId} ended '${redeemed.outcome}'`);
  }
  return found.token;
}

/**
 * Makes a connection `unowned` the way production does (spec §2.3): its owner becomes a
 * group without member, then the sweep that follows every membership removal marks it.
 * Returns that group, so a test can let a member join afterwards. The sweep is global:
 * every other active connection whose owner group is empty becomes `unowned` too.
 */
export async function makeUnowned(
  store: Pick<Store, 'connections' | 'groups'>,
  connectionId: string,
): Promise<GroupRecord> {
  const group = await store.groups.createLocal(`ownerless-${connectionId}`);
  if (!group) throw new InvariantError(`group ownerless-${connectionId} already exists`);
  await store.connections.transferOwner(connectionId, { kind: 'group', id: group.id });
  await store.connections.markOwnerlessUnowned();
  const connection = await store.connections.getById(connectionId);
  if (connection?.status !== 'unowned') {
    throw new InvariantError(
      `connection ${connectionId} is '${connection?.status}', not unowned: only an active connection becomes unowned`,
    );
  }
  return group;
}

/**
 * Moves the `first_seen_at` of every resource row of a connection back past the stale
 * grace (`FRESH_RESOURCE_STALE_GRACE_MS`, ADR created-resources-join-the-mission), so the
 * next discovery that misses a ref marks it stale at once — what a row seen long ago gets.
 */
export function agePastStaleGrace(store: Pick<Store, 'db'>, connectionId: string): void {
  store.db
    .prepare('UPDATE connection_resources SET first_seen_at = ? WHERE connection_id = ?')
    .run('2000-01-01T00:00:00.000Z', connectionId);
}
