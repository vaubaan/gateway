import { assertKnownRiskIds } from '../../catalog-index.ts';
import { InvariantError, NotFoundError } from '../../errors.ts';
import type {
  MissionAccountInput,
  MissionPolicyEntry,
  MissionPolicyLineInput,
  MissionResourceSetInput,
} from '../../types.ts';
import type { RepoContext } from '../context.ts';
import { isRiskOfService } from './rows.ts';

/** An account of a write, with its sets and their lines. */
export interface ResolvedAccountInput {
  readonly accountId: string;
  readonly resourceSets: readonly MissionResourceSetInput[];
}

/** A set of a write with its environment read from its resources (`assertAccountSelections`). */
export interface CheckedSetInput extends MissionResourceSetInput {
  readonly future: boolean;
  readonly env: string | null;
}

/** An account of a write whose sets were checked. */
export interface CheckedAccountInput {
  readonly accountId: string;
  readonly resourceSets: readonly CheckedSetInput[];
}

/**
 * The accounts of a write with their sets: an account given with its selection
 * directly becomes one set holding the `policy` lines of its service. A line no
 * account of that shape is for is refused.
 */
export function resolveAccountInputs(
  ctx: RepoContext,
  accounts: readonly MissionAccountInput[],
  policy: readonly MissionPolicyLineInput[] = [],
): ResolvedAccountInput[] {
  const serviceOf = ctx.db.prepare<[string], { service: string }>(
    'SELECT service FROM accounts WHERE id = ?',
  );
  const placed = new Set<MissionPolicyLineInput>();
  const resolved = accounts.map((c): ResolvedAccountInput => {
    if ('resourceSets' in c) return { accountId: c.accountId, resourceSets: c.resourceSets };
    const service = serviceOf.get(c.accountId)?.service;
    if (service === undefined) throw new NotFoundError('account', c.accountId);
    const lines = policy.filter((line) => isRiskOfService(line.riskId, service));
    for (const line of lines) placed.add(line);
    return {
      accountId: c.accountId,
      resourceSets: [
        {
          resourceIds: c.resourceIds,
          ...(c.future !== undefined ? { future: c.future } : {}),
          ...(c.env !== undefined ? { env: c.env } : {}),
          ...(c.trustLevels ? { trustLevels: c.trustLevels } : {}),
          policy: lines,
        },
      ],
    };
  });
  const unplaced = policy.filter((line) => !placed.has(line));
  if (unplaced.length > 0) {
    throw new InvariantError(
      `policy line(s) ${unplaced.map((l) => l.riskId).join(', ')} name no account of the mission`,
    );
  }
  return resolved;
}

/**
 * Every account carries at least one set; each set an explicit list of resources of
 * that account, all of one effective environment (own label, else the account's
 * default), which is the set's `env` — or the `env` given, which every resource must
 * carry (ADR resource-set-is-one-environment-with-optional-future-resources). The sets of
 * an account partition its selection: a resource in one set only, and one set at most
 * with future on per environment. Returns the sets with their environment.
 */
export function assertAccountSelections(
  ctx: RepoContext,
  accounts: readonly ResolvedAccountInput[],
): CheckedAccountInput[] {
  if (accounts.length === 0) {
    throw new InvariantError('a mission carries at least one account');
  }
  const resourceOf = ctx.db.prepare<[string], { account_id: string; env: string | null }>(
    `SELECT r.account_id, COALESCE(r.env, c.default_env) AS env
     FROM account_resources r JOIN accounts c ON c.id = r.account_id WHERE r.id = ?`,
  );
  const seenAccounts = new Set<string>();
  return accounts.map((c): CheckedAccountInput => {
    if (seenAccounts.has(c.accountId)) {
      throw new InvariantError(`account ${c.accountId} is listed twice`);
    }
    seenAccounts.add(c.accountId);
    if (c.resourceSets.length === 0) {
      throw new InvariantError(`account ${c.accountId}: no resource set`);
    }
    const seenResources = new Set<string>();
    const seenSets = new Set<string>();
    const futureEnvs = new Set<string | null>();
    const resourceSets = c.resourceSets.map((set): CheckedSetInput => {
      if (set.id !== undefined) {
        if (seenSets.has(set.id)) {
          throw new InvariantError(`resource set ${set.id} is listed twice`);
        }
        seenSets.add(set.id);
      }
      const envs = new Set<string | null>();
      for (const resourceId of set.resourceIds) {
        if (seenResources.has(resourceId)) {
          throw new InvariantError(
            `resource ${resourceId} is in two resource sets of account ${c.accountId}`,
          );
        }
        seenResources.add(resourceId);
        const owner = resourceOf.get(resourceId);
        if (!owner) throw new NotFoundError('account_resource', resourceId);
        if (owner.account_id !== c.accountId) {
          throw new InvariantError(
            `resource ${resourceId} does not belong to account ${c.accountId}`,
          );
        }
        envs.add(owner.env);
      }
      if (set.env !== undefined) envs.add(set.env);
      if (envs.size > 1) {
        throw new InvariantError(
          `account ${c.accountId}: a resource set holds several environments`,
        );
      }
      const [env = null] = envs;
      const future = set.future ?? false;
      if (future) {
        if (futureEnvs.has(env)) {
          throw new InvariantError(
            `account ${c.accountId}: two resource sets take the future resources of one environment`,
          );
        }
        futureEnvs.add(env);
      }
      return { ...set, future, env };
    });
    return { accountId: c.accountId, resourceSets };
  });
}

function validateLines(
  ctx: RepoContext,
  lines: readonly MissionPolicyLineInput[],
  where: string,
): void {
  const ids = lines.map((p) => p.riskId);
  if (new Set(ids).size !== ids.length) {
    throw new InvariantError(`duplicate risk id in the policy of ${where}`);
  }
  assertKnownRiskIds(ctx.catalog, ids);
  for (const entry of lines) {
    if (!Number.isInteger(entry.quota) || entry.quota < 0) {
      throw new InvariantError(`quota must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateLimit) || entry.rateLimit < 0) {
      throw new InvariantError(`rate limit must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateWindowSeconds) || entry.rateWindowSeconds <= 0) {
      throw new InvariantError(`rate window must be a positive integer (${entry.riskId})`);
    }
  }
}

/** Every line of every set, checked; a line of one set appears once in it. */
export function validateSets(ctx: RepoContext, accounts: readonly ResolvedAccountInput[]): void {
  for (const c of accounts) {
    for (const [index, set] of c.resourceSets.entries()) {
      validateLines(ctx, set.policy, `resource set ${index + 1} of account ${c.accountId}`);
    }
  }
}

/** A flat policy whose lines name sets: each (set, risk) once, each set one of `sets`. */
export function validateFlatPolicy(
  ctx: RepoContext,
  policy: readonly MissionPolicyEntry[],
  sets: ReadonlySet<string>,
): void {
  const keys = policy.map((p) => `${p.resourceSetId}\n${p.riskId}`);
  if (new Set(keys).size !== keys.length) throw new InvariantError('duplicate line in policy');
  for (const line of policy) {
    if (!sets.has(line.resourceSetId)) {
      throw new InvariantError(`resource set ${line.resourceSetId} is not one of the mission's`);
    }
  }
  validateLines(
    ctx,
    policy
      .map(({ resourceSetId: _set, ...line }) => line)
      .filter((line, i, all) => all.findIndex((other) => other.riskId === line.riskId) === i),
    'the mission',
  );
}
