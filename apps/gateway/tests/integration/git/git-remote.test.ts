/**
 * The git remote end to end with the real `git` client (spec §4.1 ter, §10;
 * ADR gateway-as-git-remote): clone, fetch, push, refusals, approval and
 * replay, limits, keys, audit and budget. GitHub is `FakeGithubHost` — the
 * real `git http-backend` and a compare API computed from the same
 * repositories; nothing reaches github.com.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { budgetMissionOf } from '../../../src/server/budget';
import type { AuditCallRecord } from '../../../src/server/store';
import { line, type IssuedMission } from '../../support/execution/testing';
import {
  ACCOUNT_TOKEN,
  DEVELOPER_TRUST_LEVELS,
  EMPTY_REPOSITORY,
  openGitRig,
  OTHER_REPOSITORY,
  REPOSITORY,
  type GitResult,
  type GitRig,
} from './support';

const PUSH = 'github__git_push';
const FETCH = 'github__git_fetch';

let rig: GitRig;
let developer: IssuedMission;

beforeAll(async () => {
  rig = await openGitRig();
  developer = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
}, 60_000);

afterAll(async () => {
  await rig.close();
});

function ok(result: GitResult): GitResult {
  if (result.code !== 0) {
    throw new Error(`git failed (${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function clone(mission: IssuedMission, extra: Record<string, string> = {}): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], mission.token, extra));
  return join(dir, 'app');
}

async function commitFile(
  repo: string,
  path: string,
  content: string,
  message = 'change',
): Promise<string> {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', message], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

async function auditOf(mission: IssuedMission) {
  return (await rig.root.store.audit.list({ missionId: mission.mission.id })).filter(
    (e): e is AuditCallRecord => e.kind === 'call',
  );
}

async function counters(mission: IssuedMission) {
  const usage = await rig.root.budget.usageOf(budgetMissionOf(mission.mission), new Date());
  // One set on the account: the counters read by risk.
  return Object.fromEntries(
    [...usage.consumed].map(([line, n]) => [line.slice(line.indexOf('::') + 2), n]),
  );
}

describe('clone and fetch', () => {
  it('clones with protocol v2, the key as the password, and records one fetch', async () => {
    const before = rig.host.requests.length;
    const repo = await clone(developer);
    expect((await rig.git(repo, ['log', '--oneline'], null)).stdout).toContain('initial');
    const upstream = rig.host.requests.slice(before);
    // git asked for v2 and GitHub was asked for v2: the header is relayed.
    expect(upstream.some((r) => r.host === 'git' && r.gitProtocol === 'version=2')).toBe(true);
    // The mission key never reaches GitHub.
    expect(upstream.every((r) => !(r.authorization ?? '').includes(developer.token))).toBe(true);
    // The account's token is what GitHub sees, as the Basic password git expects.
    const basic = `Basic ${Buffer.from(`x-access-token:${ACCOUNT_TOKEN}`).toString('base64')}`;
    expect(upstream.filter((r) => r.host === 'git').every((r) => r.authorization === basic)).toBe(
      true,
    );
    const fetches = (await auditOf(developer)).filter((e) => e.tool === FETCH);
    expect(fetches.map((e) => [e.decision, e.risks_touched])).toEqual([
      ['allowed', ['github.read-code']],
    ]);
    // The bytes of the relay (Activity's Overview): git's request up, the pack down.
    expect(fetches[0]?.request_bytes).toBeGreaterThan(0);
    expect(fetches[0]?.response_bytes).toBeGreaterThan(100);
  });

  it('clones with protocol v0 as well', async () => {
    const before = rig.host.requests.length;
    const repo = await clone(developer, { 'protocol.version': '0' });
    expect((await rig.git(repo, ['rev-parse', 'HEAD'], null)).code).toBe(0);
    const upstream = rig.host.requests.slice(before).filter((r) => r.host === 'git');
    expect(upstream.every((r) => r.gitProtocol === null)).toBe(true);
  });

  it('fetches what was pushed upstream since the clone', async () => {
    const repo = await clone(developer);
    const seed = rig.workdir();
    ok(await rig.git(seed, ['clone', '-q', rig.host.bare(REPOSITORY), 'w'], null));
    const sha = await commitFile(join(seed, 'w'), 'NOTES.md', 'notes\n', 'notes');
    ok(await rig.git(join(seed, 'w'), ['push', '-q', 'origin', 'main'], null));
    ok(await rig.git(repo, ['fetch', '-q', 'origin'], developer.token));
    expect((await rig.git(repo, ['rev-parse', 'origin/main'], null)).stdout.trim()).toBe(sha);
  });

  it('refuses a repository outside the mission, naming it', async () => {
    const dir = rig.workdir();
    const result = await rig.git(
      dir,
      ['clone', '-q', rig.remote(OTHER_REPOSITORY), 'lib'],
      developer.token,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`repository ${OTHER_REPOSITORY} is not in this mission`);
  });
});

describe('push', () => {
  it('pushes a new feature branch: decided, moved with its old id, temporary refs gone', async () => {
    const repo = await clone(developer);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/x'], null));
    const sha = await commitFile(repo, 'src/a.ts', 'export const a = 1;\n');
    const result = ok(await rig.git(repo, ['push', '-u', 'origin', 'feature/x'], developer.token));
    expect(result.stderr).toContain('[new branch]');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/x')).toBe(sha);
    const refs = Object.keys(await rig.host.refs(REPOSITORY));
    expect(refs.filter((r) => r.startsWith('refs/vaubaan/'))).toEqual([]);
    const push = (await auditOf(developer)).filter((e) => e.tool === PUSH).at(-1);
    expect(push).toMatchObject({ decision: 'allowed' });
    // What the push carried up is its pack (`payload_bytes`), not its arguments.
    expect(push?.request_bytes).toBeGreaterThan(50);
    expect(push?.response_bytes).toBeGreaterThan(0);
    expect([...(push?.risks_touched ?? [])].sort()).toEqual([
      'github.feature-branch-write',
      'github.git-push',
    ]);
    // A fast-forward on the same branch.
    const next = await commitFile(repo, 'src/b.ts', 'export const b = 2;\n');
    ok(await rig.git(repo, ['push', 'origin', 'feature/x'], developer.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/x')).toBe(next);
    expect((await counters(developer))['github.git-push']).toBe(2);
  });

  it('refuses a push to main with the missing permission, and stores nothing upstream', async () => {
    const repo = await clone(developer);
    await commitFile(repo, 'src/main.ts', 'x\n');
    const main = await rig.host.refOf(REPOSITORY, 'refs/heads/main');
    const before = rig.host.requests.length;
    const result = await rig.git(repo, ['push', 'origin', 'main'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      '[remote rejected] main -> main (permission github.merge-protected is not in this mission)',
    );
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/main')).toBe(main);
    expect(
      rig.host.requests
        .slice(before)
        .filter((r) => r.method === 'POST' && r.path.endsWith('/git-receive-pack')),
    ).toEqual([]);
  });

  it('refuses a ref under refs/vaubaan/ and any ref outside branches and tags', async () => {
    const repo = await clone(developer);
    const reserved = await rig.git(
      repo,
      ['push', 'origin', 'HEAD:refs/vaubaan/x'],
      developer.token,
    );
    expect(reserved.stderr).toContain("'refs/vaubaan/' is reserved by the gateway");
    const notes = await rig.git(repo, ['push', 'origin', 'HEAD:refs/notes/x'], developer.token);
    expect(notes.stderr).toContain(
      'only branches (refs/heads/...) and tags (refs/tags/...) can be pushed',
    );
  });

  it('a force-push asks first; the same push again passes once approved', async () => {
    const repo = await clone(developer);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/rewrite'], null));
    await commitFile(repo, 'src/r.ts', 'one\n');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/rewrite'], developer.token));
    ok(await rig.git(repo, ['commit', '-q', '--amend', '-m', 'rewritten'], null));
    const rewritten = (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();

    const refused = await rig.git(
      repo,
      ['push', '-f', 'origin', 'feature/rewrite'],
      developer.token,
    );
    expect(refused.code).not.toBe(0);
    const url = /approval required — (\S+)\)/.exec(refused.stderr)?.[1];
    expect(url, refused.stderr).toMatch(/\/r\/[0-9a-f-]{36}$/);
    expect(refused.stderr).toContain('remote: Vaubaan: Hand this URL to your human:');
    expect(refused.stderr).toContain('push the same commits again');
    // The temporary ref stays while the request is open, for the person to read the diff.
    const pending = await rig.root.store.pendingRefs.listFor(developer.mission.id, REPOSITORY);
    expect(pending.map((p) => p.objectId)).toEqual([rewritten]);
    expect(await rig.host.refOf(REPOSITORY, pending[0]!.ref)).toBe(rewritten);

    const requestId = url!.slice(url!.lastIndexOf('/') + 1);
    const viewed = await rig.root.requests.service.view(rig.ada, requestId);
    if (viewed.outcome !== 'ok' || viewed.view.kind !== 'approval')
      throw new Error('no approval view');
    expect(viewed.view.call.tool).toBe(PUSH);
    expect(viewed.view.call.arguments).toMatchObject({
      repository: REPOSITORY,
      updates: [{ ref: 'refs/heads/feature/rewrite', kind: 'force', new: rewritten }],
    });
    // The person who answers reads the rewrite at GitHub: the commits wait under the temporary ref.
    const pages = viewed.view.call.service_pages;
    expect(pages.map((p) => p.label)).toEqual(['refs/heads/feature/rewrite']);
    expect(pages[0]?.url).toMatch(
      new RegExp(`^https://github\\.com/${REPOSITORY}/compare/[0-9a-f]{40}\\.\\.\\.${rewritten}$`),
    );
    expect(
      await rig.root.requests.service.decide(rig.ada, requestId, { resolution: 'grant' }),
    ).toMatchObject({ ok: true });

    ok(await rig.git(repo, ['push', '-f', 'origin', 'feature/rewrite'], developer.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/rewrite')).toBe(rewritten);
    expect(await rig.root.store.pendingRefs.listFor(developer.mission.id, REPOSITORY)).toEqual([]);
    const refs = Object.keys(await rig.host.refs(REPOSITORY));
    expect(refs.filter((r) => r.startsWith('refs/vaubaan/'))).toEqual([]);
  });

  it('a push that changes a workflow asks first', async () => {
    const repo = await clone(developer);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/ci'], null));
    await commitFile(repo, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: { x: {} }\n');
    const result = await rig.git(repo, ['push', 'origin', 'feature/ci'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/approval required — /);
    const refusal = (await auditOf(developer)).filter((e) => e.tool === PUSH).at(-1);
    expect(refusal?.refusal_code).toBe('approval-required');
    expect(refusal?.risks_touched).toContain('github.workflow-write-via-file');
  });

  it('tags and deletions need their own permissions', async () => {
    const repo = await clone(developer);
    // Pushes on work branches, without the tag and branch-delete lines.
    const pusher = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.feature-branch-write'),
      ],
    });
    ok(await rig.git(repo, ['tag', 'v9.9.9'], null));
    const tag = await rig.git(repo, ['push', 'origin', 'v9.9.9'], pusher.token);
    expect(tag.stderr).toContain('github.tag-write');
    const del = await rig.git(repo, ['push', 'origin', ':feature/x'], pusher.token);
    expect(del.stderr).toContain('github.branch-delete');

    const release = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.tag-write'),
        line('github.create-release'),
        line('github.feature-branch-write'),
        line('github.branch-delete'),
      ],
    });
    ok(await rig.git(repo, ['push', 'origin', 'v9.9.9'], release.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v9.9.9')).not.toBeNull();
    ok(await rig.git(repo, ['push', 'origin', ':feature/x'], release.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/x')).toBeNull();
  });

  it('an annotated tag is reviewed through the commit it points at, like a lightweight tag', async () => {
    const repo = await clone(developer);
    const release = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.tag-write'),
        line('github.create-release'),
      ],
    });
    const head = (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
    ok(await rig.git(repo, ['tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0', head], null));
    const tagObject = (await rig.git(repo, ['rev-parse', 'refs/tags/v1.0.0'], null)).stdout.trim();
    expect(tagObject).not.toBe(head);
    const annotated = await rig.git(repo, ['push', 'origin', 'v1.0.0'], release.token);
    expect(annotated.stderr).not.toContain('cannot be reviewed');
    ok(annotated);
    // The ref holds the tag object (its message kept), not the commit.
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v1.0.0')).toBe(tagObject);
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v1.0.0^{commit}')).toBe(head);

    ok(await rig.git(repo, ['tag', 'v1.0.1', head], null));
    ok(await rig.git(repo, ['push', 'origin', 'v1.0.1'], release.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v1.0.1')).toBe(head);
  });

  it('an annotated tag of a commit no branch reaches is refused: no history in common', async () => {
    const repo = await clone(developer);
    const release = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.tag-write'),
        line('github.create-release'),
      ],
    });
    // An orphan commit with the same `.github` tree: no workflow change to ask about.
    ok(await rig.git(repo, ['checkout', '-q', '--orphan', 'elsewhere'], null));
    const orphan = await commitFile(repo, 'README.md', '# elsewhere\n');
    ok(await rig.git(repo, ['tag', '-a', 'v2.0.0', '-m', 'Release 2.0.0', orphan], null));
    const result = await rig.git(repo, ['push', 'origin', 'v2.0.0'], release.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'refs/tags/v2.0.0 cannot be reviewed: it has no history in common with',
    );
    expect(result.stderr).toContain('git rebase origin/main');
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v2.0.0')).toBeNull();
  });

  it('pushes the first branch of an empty repository: every file of its history reviewed', async () => {
    const owner = await rig.mission({
      repositories: [EMPTY_REPOSITORY],
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.merge-protected'),
        line('github.feature-branch-write'),
      ],
    });
    const repo = join(rig.workdir(), 'fresh');
    mkdirSync(repo);
    ok(await rig.git(repo, ['init', '-q', '--initial-branch=main'], null));
    await commitFile(repo, 'README.md', '# fresh\n', 'first');
    const head = await commitFile(repo, 'src/index.html', '<p>hi</p>\n', 'second');
    ok(await rig.git(repo, ['remote', 'add', 'origin', rig.remote(EMPTY_REPOSITORY)], null));
    const result = await rig.git(repo, ['push', '-u', 'origin', 'main'], owner.token);
    expect(result.stderr).not.toContain('cannot be reviewed');
    ok(result);
    expect(await rig.host.refOf(EMPTY_REPOSITORY, 'refs/heads/main')).toBe(head);
    const push = (await auditOf(owner)).filter((e) => e.tool === PUSH).at(-1);
    expect(push).toMatchObject({ decision: 'allowed' });
    expect([...(push?.risks_touched ?? [])].sort()).toEqual([
      'github.git-push',
      'github.merge-protected',
    ]);
    // Nothing to compare with: the tip's whole tree was read instead.
    expect(rig.host.requests.some((r) => r.path.endsWith('?recursive=1'))).toBe(true);
  });

  it('refuses a push the compare API cannot review in full (300 files)', async () => {
    const repo = await clone(developer);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/huge'], null));
    for (let i = 0; i < 300; i += 1) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    ok(await rig.git(repo, ['add', '-A'], null));
    ok(await rig.git(repo, ['commit', '-q', '-m', 'many files'], null));
    const huge = (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
    const result = await rig.git(repo, ['push', 'origin', 'feature/huge'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('too large to review (300 or more files)');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/huge')).toBeNull();
    // The pack was stored to be reviewed; its temporary ref is gone.
    const refs = await rig.host.refs(REPOSITORY);
    expect(
      Object.entries(refs).filter(
        ([name, sha]) => name.startsWith('refs/vaubaan/') && sha === huge,
      ),
    ).toEqual([]);
    const refusal = (await auditOf(developer)).filter((e) => e.tool === PUSH).at(-1);
    expect(refusal).toMatchObject({ decision: 'refused', refusal_code: null });
    expect(refusal?.refusal_reason).toContain('too large to review');
  });
});

describe('keys', () => {
  it('asks for a key, and refuses a wrong one', async () => {
    const dir = rig.workdir();
    const none = await rig.git(dir, ['clone', '-q', rig.remote(), 'a'], null);
    expect(none.code).not.toBe(0);
    const wrong = await rig.git(
      dir,
      ['clone', '-q', rig.remote(), 'b'],
      `vbn_live_${randomBytes(24).toString('hex')}`,
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toMatch(/Authentication failed|401/);
  });

  it('refuses a revoked mission with its reason', async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    await rig.root.missions.service.revoke(rig.ada, mission.mission.id);
    const dir = rig.workdir();
    const result = await rig.git(dir, ['clone', '-q', rig.remote(), 'a'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/mission/);
  });

  it('refuses git through a revoked account of a mission that still serves its others', async () => {
    const token = `ghp_${randomBytes(18).toString('hex')}`;
    const account = await rig.tokenHolding(token, { metadata: 'read', contents: 'write' });
    const issued = await rig.root.missions.service.issue(rig.ada, {
      name: 'Two accounts',
      accounts: [
        { account_id: account.id, trust_levels: DEVELOPER_TRUST_LEVELS },
        {
          account_id: rig.account.id,
          resources: { scope: 'all' },
          policy: [line('depot.read')],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    await rig.root.store.accounts.revoke(account.id);

    const result = await rig.git(
      rig.workdir(),
      ['clone', '-q', rig.remote(), 'a'],
      issued.token.secret,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/was removed and no longer serves this mission/);
    const other = await rig.call(
      { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix },
      'depot__read_item',
      { space: 'scratch' },
    );
    expect(other.error).toBeUndefined();
  });
});

describe('the service segment', () => {
  const doorPath = (path: string) => new URL(`/git/${path}`, rig.remoteBase).href;

  it('answers 404 to a service that is unknown, or serves no git remote, before any key', async () => {
    const unknown = await fetch(doorPath('acme/app.git/info/refs?service=git-upload-pack'));
    expect(unknown.status).toBe(404);
    const unknownText = await unknown.text();
    expect(unknownText).toContain("'acme' is not a service of this instance");
    expect(unknownText).toContain('Git remotes here: /git/github/');
    expect(unknownText).toContain('Take the setup kit of your mission again');

    const noRemote = await fetch(doorPath('depot/acme/app.git/info/refs?service=git-upload-pack'));
    expect(noRemote.status).toBe(404);
    expect(await noRemote.text()).toContain('is not served as a git remote by this instance');

    const bare = await fetch(doorPath(''));
    expect(bare.status).toBe(404);
  });

  it('refuses, and audits, a mission that holds no account on the service the path names', async () => {
    const issued = await rig.root.missions.service.issue(rig.ada, {
      name: 'No GitHub',
      accounts: [
        {
          account_id: rig.account.id,
          resources: { scope: 'all' },
          policy: [line('depot.read')],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    const result = await rig.git(
      rig.workdir(),
      ['clone', '-q', rig.remote(), 'a'],
      issued.token.secret,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('this mission holds no GitHub account');
    const audit = await auditOf({
      mission: issued.mission,
      token: issued.token.secret,
      prefix: issued.token.prefix,
    });
    expect(audit.some((e) => e.tool === FETCH && e.decision === 'refused')).toBe(true);
  });
});

describe('the other door', () => {
  it('refuses the git tools over MCP, and answers Git LFS that it is not served', async () => {
    const body = await rig.call(developer, PUSH, { repository: REPOSITORY, updates: [] });
    expect(body.error?.message).toContain('cannot be called over MCP');
    const lfs = await fetch(`${rig.remote()}/info/lfs/objects/batch`, { method: 'POST' });
    expect(lfs.status).toBe(501);
    expect(((await lfs.json()) as { message: string }).message).toContain(
      'Git LFS is not supported',
    );
  });
});
