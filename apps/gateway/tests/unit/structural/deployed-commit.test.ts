/**
 * Structural test: the commit `/healthz` reports is one the build saw for itself
 * (docs/workflow/coding-workflow.md).
 *
 * `git archive` writes the archived commit into `apps/gateway/build-commit.txt`
 * (`.gitattributes`: export-subst); `next.config.ts` reads it, else the
 * checkout's HEAD, else `unknown`. No build argument and no environment
 * variable feed it: a platform variable set by hand once (Railway, 2026-10-16)
 * kept reporting an old commit across deployments.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { COMMIT_STAMP_FILE, commitFromStamp, resolveCommitSha } from '../../../next.config';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const STAMP_PATH = `apps/gateway/${COMMIT_STAMP_FILE}`;
const PLACEHOLDER = '$Format:%H$';
const FULL = '0123456789abcdef0123456789abcdef01234567';

const read = (path: string): string => readFileSync(resolve(REPO, path), 'utf8');

describe('commitFromStamp', () => {
  it('reads the short commit of a stamped file', () => {
    expect(commitFromStamp(`${FULL}\n`)).toBe('0123456');
  });

  it.each([
    ['the placeholder of a checkout', `${PLACEHOLDER}\n`],
    ['no file', null],
    ['an empty file', ''],
    ['a short id', '0123456'],
    ['upper case', FULL.toUpperCase()],
    ['anything else', 'main'],
  ])('is null for %s', (_label, text) => {
    expect(commitFromStamp(text)).toBeNull();
  });
});

describe('resolveCommitSha', () => {
  it('prefers the stamp to the checkout', () => {
    expect(resolveCommitSha({ stamp: FULL, checkout: () => 'fedcba9' })).toBe('0123456');
  });

  it('falls back to the checkout when the file is not stamped', () => {
    expect(resolveCommitSha({ stamp: PLACEHOLDER, checkout: () => 'fedcba9-dirty' })).toBe(
      'fedcba9-dirty',
    );
  });

  it('says unknown rather than guess', () => {
    expect(resolveCommitSha({ stamp: null, checkout: () => null })).toBe('unknown');
  });
});

describe('the stamp is written by git archive and by nothing else', () => {
  it('the checked-in file is the placeholder', () => {
    expect(read(STAMP_PATH).trim()).toBe(PLACEHOLDER);
  });

  it('.gitattributes marks it export-subst', () => {
    const lines = read('.gitattributes').split('\n');
    expect(lines).toContain(`${STAMP_PATH} export-subst`);
  });

  it('no build argument or variable names a commit', () => {
    expect(read('deploy/docker/Dockerfile')).not.toMatch(/^\s*(ARG|ENV)\s+\S*COMMIT/im);
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(read(workflow)).not.toContain('GIT_COMMIT_SHA');
    }
    expect(read('apps/gateway/next.config.ts')).not.toMatch(/process\.env\.\w*COMMIT/);
  });

  it('neither the image context nor the Railway upload leaves it out', () => {
    for (const file of ['.dockerignore', '.railwayignore']) {
      expect(read(file)).not.toContain('build-commit');
    }
  });

  const scratch = mkdtempSync(join(tmpdir(), 'vaubaan-stamp-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('an archive of a commit carries that commit', () => {
    const repo = join(scratch, 'repo');
    mkdirSync(join(repo, 'apps/gateway'), { recursive: true });
    copyFileSync(resolve(REPO, '.gitattributes'), join(repo, '.gitattributes'));
    copyFileSync(resolve(REPO, STAMP_PATH), join(repo, STAMP_PATH));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'stamp');
    const head = git('rev-parse', 'HEAD').trim();
    const tarball = join(scratch, 'release.tar');
    git('archive', '--format=tar', `--output=${tarball}`, 'HEAD');
    const content = execFileSync('tar', ['-xOf', tarball, STAMP_PATH], { encoding: 'utf8' });
    expect(content.trim()).toBe(head);
    expect(commitFromStamp(content)).toBe(head.slice(0, 7));
  });
});
