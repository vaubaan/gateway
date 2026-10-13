#!/usr/bin/env node
// What the release workflow (.github/workflows/release.yml) is about to ship:
// the version, whether it is a pre-release, the image tags and the release
// notes. Run by the workflow's first job; runs the same on a laptop.
//
//   git tag --list 'v*' | node scripts/release-plan.mjs --tag v2.1.0 --notes-out notes.md
//   node scripts/release-plan.mjs --dry-run --notes-out notes.md
//
// --tag <tag>   a real release. The tag must name the version of package.json,
//               be the highest release among the tags read from standard input,
//               and CHANGELOG.md must have a dated section for it (not
//               "Unreleased").
// --dry-run     a rehearsal of the current tree. Same checks on the version;
//               when CHANGELOG.md has no section for it yet, the notes are a
//               preview of "Unreleased" and a warning says so.
//
// Writes `version`, `prerelease` and `image_tags` to $GITHUB_OUTPUT when set.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseError,
  assertReleasableTag,
  extractReleaseNotes,
  imageTags,
  parseVersion,
  unreleasedNotes,
} from './release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: release-plan.mjs (--tag <tag> | --dry-run) --notes-out <file>';

function parseArguments(argv) {
  const options = { tag: null, dryRun: false, notesOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--tag' || argument === '--notes-out') {
      const value = argv[index + 1];
      if (!value) throw new ReleaseError(`${argument} needs a value\n${USAGE}`);
      if (argument === '--tag') options.tag = value;
      else options.notesOut = value;
      index += 1;
    } else {
      throw new ReleaseError(`unknown argument ${argument}\n${USAGE}`);
    }
  }
  if ((options.tag === null) === !options.dryRun || options.notesOut === null) {
    throw new ReleaseError(USAGE);
  }
  return options;
}

function dryRunNotes(changelog, version) {
  try {
    return extractReleaseNotes(changelog, version.raw);
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.log(
      `::warning title=Release notes are a preview::${error.message} ` +
        'A tag pushed on this commit would be refused.',
    );
    return `${unreleasedNotes(changelog)}\n`;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');

  let version;
  let notes;
  if (options.tag !== null) {
    const existingTags = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    version = assertReleasableTag({ tag: options.tag, manifestVersion, existingTags });
    notes = extractReleaseNotes(changelog, version.raw);
  } else {
    version = parseVersion(manifestVersion);
    notes = dryRunNotes(changelog, version);
  }

  const tags = imageTags(version);
  writeFileSync(options.notesOut, notes);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `version=${version.raw}`,
        `prerelease=${version.prerelease !== null}`,
        'image_tags<<RELEASE_PLAN_EOF',
        ...tags,
        'RELEASE_PLAN_EOF',
        '',
      ].join('\n'),
    );
  }
  console.log(
    [
      `version:     ${version.raw}${options.dryRun ? ' (dry run)' : ''}`,
      `pre-release: ${version.prerelease !== null ? 'yes' : 'no'}`,
      `image tags:  ${tags.join(', ')}`,
      `notes:       ${options.notesOut} (${notes.length} characters)`,
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`::error title=Release refused::${error.message}`);
  process.exit(1);
}
