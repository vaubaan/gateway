#!/usr/bin/env node
/**
 * Sign-off check (CI job "audit", on a pull request): every commit the pull
 * request brings carries a `Signed-off-by:` line, the Developer Certificate of
 * Origin (CONTRIBUTING.md, "Licence and sign-off").
 *
 *   node scripts/dco-check.mjs <base-commit> [<head-commit>]
 *
 * Reads `git log --no-merges <base>..<head>`: merge commits are left out (the
 * one GitHub makes to test a pull request, and "Update branch"). A line
 * `Signed-off-by: Name <address>` anywhere in the message is enough; the
 * address is not compared with the author's (Dependabot signs with another
 * address than the one it commits with). Exit 1 with one line per unsigned
 * commit; 0 and a note when there is no base to compare with.
 *
 * No third-party action: a few lines of git, like the other gates.
 * `unsignedCommits()` is pure and unit-tested (scripts/dco-check.test.mjs).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELD = '\x1f';
const RECORD = '\x1e';
const SIGN_OFF = /^Signed-off-by: *[^<\n]*\S *<[^<>\s@]+@[^<>\s]+> *$/m;

/**
 * @typedef {{ sha: string, subject: string, message: string }} Commit
 */

/**
 * The commits of `log` (the output of `git log --format=%H%x1f%s%x1f%B%x1e`).
 * @param {string} log
 * @returns {Commit[]}
 */
export function parseLog(log) {
  return log
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', subject = '', message = ''] = record.split(FIELD);
      return { sha, subject, message };
    });
}

/**
 * True when the message carries a sign-off with a name and an address.
 * @param {string} message
 */
export function isSignedOff(message) {
  return SIGN_OFF.test(message);
}

/**
 * The commits without a sign-off, in the order given.
 * @param {Commit[]} commits
 * @returns {Commit[]}
 */
export function unsignedCommits(commits) {
  return commits.filter((commit) => !isSignedOff(commit.message));
}

/**
 * @param {string} base
 * @param {string} head
 */
function commitsBetween(base, head) {
  const log = execFileSync(
    'git',
    ['log', '--no-merges', `--format=%H${FIELD}%s${FIELD}%B${RECORD}`, `${base}..${head}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseLog(log);
}

function main() {
  const [base = '', head = 'HEAD'] = process.argv.slice(2);
  if (base === '' || /^0+$/.test(base)) {
    console.log('dco-check: no base commit, nothing to check.');
    return 0;
  }
  const commits = commitsBetween(base, head);
  const unsigned = unsignedCommits(commits);
  for (const commit of unsigned) {
    console.error(`::error title=Sign-off missing::${commit.sha.slice(0, 12)} ${commit.subject}`);
  }
  if (unsigned.length > 0) {
    console.error(
      `dco-check: ${unsigned.length} of ${commits.length} commits carry no "Signed-off-by:" line. ` +
        'Sign them (CONTRIBUTING.md, "Licence and sign-off"): ' +
        `git rebase --signoff ${base.slice(0, 12)}, then push again.`,
    );
    return 1;
  }
  console.log(`dco-check: ${commits.length} commits, all signed off.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
