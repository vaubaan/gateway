/**
 * The git remote's limits and edges (spec §4.1 ter; ADR gateway-as-git-remote
 * D1, D5, D6, D10): the pack cap, the budget, keys that stopped working, an
 * expired mission, a token account, the sweeper of temporary refs, the
 * catalog's remote URL, and the one admission both doors share.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serializeSecret } from '../../../src/server/accounts';
import type { AuditCallRecord } from '../../../src/server/store';
import { line, TEST_PUBLIC_URL, type IssuedMission } from '../../support/execution/testing';
import {
  DEVELOPER_TRUST_LEVELS,
  openGitRig,
  REPOSITORY,
  type GitResult,
  type GitRig,
} from './support';

let rig: GitRig;

beforeAll(async () => {
  rig = await openGitRig({ env: { VAUBAAN_GIT_MAX_PACK_MB: '1' } });
}, 60_000);

afterAll(async () => {
  await rig.close();
});

function ok(result: GitResult): GitResult {
  if (result.code !== 0) throw new Error(`git failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function cloneWith(mission: IssuedMission): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], mission.token));
  return join(dir, 'app');
}

async function commit(repo: string, path: string, content: string | Buffer): Promise<string> {
  writeFileSync(join(repo, path), content);
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', path], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

describe('the pack cap', () => {
  it('refuses a push over git.max_pack_mb, audits it, and leaves nothing upstream', async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    const repo = await cloneWith(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/big'], null));
    await commit(repo, 'big.bin', randomBytes(3 * 1024 * 1024));
    const result = await rig.git(repo, ['push', 'origin', 'feature/big'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('larger than the 1 MB this gateway accepts');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/big')).toBeNull();
    const entries = await rig.root.store.audit.list({ missionId: mission.mission.id });
    // One entry for the push; git's probe before a large body is not a call.
    const pushes = entries.filter(
      (e): e is AuditCallRecord => e.kind === 'call' && e.tool === 'github__git_push',
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ decision: 'refused', refusal_code: null });
    expect(pushes[0]?.refusal_reason).toContain('1 MB limit');
  });
});

describe('the budget', () => {
  it('counts every push against git-push and refuses once the quota is spent, with the claim URL', async () => {
    const mission = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push', 1),
        line('github.feature-branch-write'),
      ],
    });
    const repo = await cloneWith(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/budget'], null));
    await commit(repo, 'one.txt', '1');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/budget'], mission.token));
    await commit(repo, 'two.txt', '2');
    const result = await rig.git(repo, ['push', 'origin', 'feature/budget'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(
      new RegExp(`limit of github.git-push reached — ${TEST_PUBLIC_URL}/r/`),
    );
  });
});

describe('keys and missions that stopped', () => {
  it('a replaced key no longer authenticates; the new one does', async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    const rotated = await rig.root.missions.service.rotate(rig.ada, mission.mission.id);
    if (!rotated.ok) throw new Error('rotate refused');
    const dir = rig.workdir();
    const old = await rig.git(dir, ['clone', '-q', rig.remote(), 'a'], mission.token);
    expect(old.code).not.toBe(0);
    expect(old.stderr).toMatch(/Authentication failed/);
    ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'b'], rotated.token.secret));
  });

  it('an expired mission is refused with its reason', async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    rig.root.store.db
      .prepare('UPDATE missions SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', mission.mission.id);
    const result = await rig.git(rig.workdir(), ['clone', '-q', rig.remote(), 'a'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('remote: Vaubaan: the mission is expired');
  });
});

describe('a token account (fine-grained personal access token)', () => {
  it('clones and pushes with the account token, never the mission key, upstream', async () => {
    const pat = `github_pat_${randomBytes(12).toString('hex')}`;
    rig.host.acceptToken(pat, { contents: 'write' });
    const { store } = rig.root;
    // Another GitHub account of Ada: the same repository, a token instead of the App.
    const tokenAccount = await store.accounts.create({
      provider: 'github',
      owner: { kind: 'user', id: rig.ada.id },
      displayName: 'acme-token',
      credential: serializeSecret({ kind: 'api-key', fields: { token: pat }, metadata: {} }),
    });
    await store.accounts.syncDiscoveredResources(tokenAccount.id, [
      { ref: REPOSITORY, displayName: REPOSITORY, env: null },
    ]);
    const issued = await rig.root.missions.service.issue(rig.ada, {
      name: 'Token account',
      accounts: [{ account_id: tokenAccount.id, trust_levels: DEVELOPER_TRUST_LEVELS }],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    const before = rig.host.requests.length;
    const dir = rig.workdir();
    ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], issued.token.secret));
    const repo = join(dir, 'app');
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/pat'], null));
    const sha = await commit(repo, 'pat.txt', 'pat');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/pat'], issued.token.secret));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/pat')).toBe(sha);
    const upstream = rig.host.requests.slice(before);
    const basic = `Basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`;
    expect(upstream.filter((r) => r.host === 'git').every((r) => r.authorization === basic)).toBe(
      true,
    );
    expect(upstream.every((r) => !(r.authorization ?? '').includes(issued.token.secret))).toBe(
      true,
    );
  });
});

describe('what the token holds at GitHub', () => {
  it('a token without contents: write still clones, and a push is refused by GitHub for that permission', async () => {
    const readOnly = await rig.tokenHolding(`github_pat_${'5151'.repeat(8)}`, {
      metadata: 'read',
      contents: 'read',
    });
    const mission = await rig.missionOn(readOnly, DEVELOPER_TRUST_LEVELS);
    const dir = rig.workdir();
    ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], mission.token));
    const repo = join(dir, 'app');
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/ro'], null));
    await commit(repo, 'ro.txt', 'ro');
    const result = await rig.git(repo, ['push', 'origin', 'feature/ro'], mission.token);
    expect(result.code).not.toBe(0);
    // GitHub refuses the pack with 403: the gateway relays the refusal, nothing moves.
    expect(result.stderr).toMatch(/HTTP 403|refused by GitHub/);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/ro')).toBeNull();
  });

  it('the mission decides a workflow change first, whatever the token holds', async () => {
    const noWorkflows = await rig.tokenHolding(`github_pat_${'6262'.repeat(8)}`, {
      metadata: 'read',
      contents: 'write',
    });
    const mission = await rig.missionOn(noWorkflows, [
      line('github.read-code'),
      line('github.git-push'),
      line('github.feature-branch-write'),
    ]);
    const repo = await cloneWith(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/ci-12'], null));
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    await commit(repo, '.github/workflows/new.yml', 'name: new\non: push\njobs: {}\n');
    const sentBefore = receivePackPosts();
    const result = await rig.git(repo, ['push', 'origin', 'feature/ci-12'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'permission github.workflow-write-via-file is not in this mission',
    );
    expect(result.stderr).not.toContain('refused by GitHub');
    expect(receivePackPosts()).toBe(sentBefore);
  });
});

/** Everything the door sent to GitHub's git endpoint that writes: receive-pack posts. */
function receivePackPosts(): number {
  return rig.host.requests.filter(
    (r) => r.host === 'git' && r.method === 'POST' && r.path.endsWith('/git-receive-pack'),
  ).length;
}

describe('temporary refs of a pending approval', () => {
  it('are swept once the request expired', async () => {
    const mission = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.feature-branch-write', 100, { gate: 'approval' }),
      ],
    });
    const repo = await cloneWith(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/wait'], null));
    const sha = await commit(repo, 'wait.txt', 'wait');
    const refused = await rig.git(repo, ['push', 'origin', 'feature/wait'], mission.token);
    expect(refused.stderr).toContain('approval required');
    const [pending] = await rig.root.store.pendingRefs.listFor(mission.mission.id, REPOSITORY);
    expect(await rig.host.refOf(REPOSITORY, pending!.ref)).toBe(sha);

    // Not yet expired: the sweeper leaves it.
    expect(await rig.root.git.sweeper.runOnce()).toBe(0);
    rig.root.store.db
      .prepare('UPDATE git_pending_refs SET expires_at = ? WHERE ref = ?')
      .run('2020-01-01T00:00:00.000Z', pending!.ref);
    expect(await rig.root.git.sweeper.runOnce()).toBe(1);
    expect(await rig.host.refOf(REPOSITORY, pending!.ref)).toBeNull();
    expect(await rig.root.store.pendingRefs.listFor(mission.mission.id, REPOSITORY)).toEqual([]);
  });
});

describe('one execution surface', () => {
  it('the git door admits with the MCP door’s own admission', () => {
    expect(rig.root.git.door.admission).toBe(rig.root.execution.door.admission);
  });

  it('the catalog gives the remote of each repository', async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    const response = await rig.root.execution.handlers.catalog(
      new Request(`${TEST_PUBLIC_URL}/mcp/catalog`, {
        headers: { authorization: `Bearer ${mission.token}` },
      }),
    );
    const catalog = (await response.json()) as {
      accounts: { provider: string; resources: { ref: string; git_remote?: string }[] }[];
    };
    const github = catalog.accounts.find((c) => c.provider === 'github');
    expect(github?.resources).toEqual([
      expect.objectContaining({
        ref: REPOSITORY,
        git_remote: `${TEST_PUBLIC_URL}/git/github/${REPOSITORY}.git`,
      }),
    ]);
  });
});
