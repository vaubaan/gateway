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
import { line, type IssuedMission } from '../../../src/server/execution/testing';
import {
  CONNECTION_TOKEN,
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
  developer = await rig.mission({ preset: 'developer' });
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
  return Object.fromEntries(usage.consumed);
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
    // The connection's token is what GitHub sees, as the Basic password git expects.
    const basic = `Basic ${Buffer.from(`x-access-token:${CONNECTION_TOKEN}`).toString('base64')}`;
    expect(upstream.filter((r) => r.host === 'git').every((r) => r.authorization === basic)).toBe(
      true,
    );
    const fetches = (await auditOf(developer)).filter((e) => e.tool === FETCH);
    expect(fetches.map((e) => [e.decision, e.risks_touched])).toEqual([
      ['allowed', ['github.read-code']],
    ]);
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
    const pages = viewed.view.call.provider_pages;
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
    ok(await rig.git(repo, ['tag', 'v9.9.9'], null));
    const tag = await rig.git(repo, ['push', 'origin', 'v9.9.9'], developer.token);
    expect(tag.stderr).toContain('github.tag-write');
    const del = await rig.git(repo, ['push', 'origin', ':feature/x'], developer.token);
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
    expect(await rig.host.refOf(REPOSITORY, 'refs/tags/v2.0.0')).toBeNull();
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
    const mission = await rig.mission({ preset: 'developer' });
    await rig.root.missions.service.revoke(rig.ada, mission.mission.id);
    const dir = rig.workdir();
    const result = await rig.git(dir, ['clone', '-q', rig.remote(), 'a'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/mission/);
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
