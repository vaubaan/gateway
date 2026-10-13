#!/usr/bin/env node
// Prepares a release commit. It edits three files and prints what to do next;
// it never commits, never creates a tag and never pushes.
//
//   npm run release:prepare -- <version> [--date YYYY-MM-DD]
//
//   CHANGELOG.md        "Unreleased" becomes "## [<version>] - <date>", a new
//                       empty "Unreleased" is left above it
//   package.json        "version" (the one source of the gateway version)
//   package-lock.json   the two copies of that version
//
// Policy: docs/workflow/coding-workflow.md ("Release").
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseError,
  assertMovesForward,
  bumpLockfile,
  bumpManifest,
  parseVersion,
  prepareChangelog,
} from './release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run release:prepare -- <version> [--date YYYY-MM-DD]';

function parseArguments(argv) {
  const positional = [];
  let date = new Date().toISOString().slice(0, 10);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--date') {
      date = argv[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new ReleaseError(`unknown option ${argument}\n${USAGE}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) throw new ReleaseError(USAGE);
  return { version: positional[0], date };
}

function main() {
  const { version, date } = parseArguments(process.argv.slice(2));
  const paths = {
    changelog: resolve(ROOT, 'CHANGELOG.md'),
    manifest: resolve(ROOT, 'package.json'),
    lockfile: resolve(ROOT, 'package-lock.json'),
  };
  const manifest = readFileSync(paths.manifest, 'utf8');
  const current = JSON.parse(manifest).version;
  const next = parseVersion(version);
  assertMovesForward(current, next.raw);

  // Compute everything before writing anything: a refusal leaves the tree untouched.
  const changelog = prepareChangelog(readFileSync(paths.changelog, 'utf8'), next.raw, date);
  const bumpedManifest = bumpManifest(manifest, next.raw);
  const bumpedLockfile = bumpLockfile(readFileSync(paths.lockfile, 'utf8'), next.raw);
  writeFileSync(paths.changelog, changelog);
  writeFileSync(paths.manifest, bumpedManifest);
  writeFileSync(paths.lockfile, bumpedLockfile);

  const tag = `v${next.raw}`;
  const branch =
    next.prerelease === null ? 'main' : 'main (or v5 until the cutover, pre-releases only)';
  console.log(
    [
      `Prepared ${next.raw} (${date}).`,
      `  CHANGELOG.md        "Unreleased" -> "[${next.raw}] - ${date}"`,
      `  package.json        ${current} -> ${next.raw}`,
      `  package-lock.json   ${current} -> ${next.raw}`,
      '',
      'Next, by hand:',
      '  1. Review the diff, then commit:',
      '       git add CHANGELOG.md package.json package-lock.json',
      `       git commit -m "chore(release): ${next.raw}"`,
      `  2. Bring that commit to ${branch} through a pull request and wait for CI.`,
      '  3. Rehearse (optional): run the "release" workflow by hand on that branch.',
      '     A manual run is a dry run: it builds and tests, and publishes nothing.',
      '  4. Tag the merged commit and push the tag. Pushing the tag publishes the release:',
      `       git tag -a ${tag} -m "Vaubaan Gateway ${next.raw}" <commit>`,
      `       git push origin ${tag}`,
      '',
      'No commit and no tag were created.',
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`release:prepare: ${error.message}`);
  process.exit(1);
}
