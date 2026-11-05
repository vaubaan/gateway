#!/usr/bin/env node
// Prepares a release commit. It edits the files below and prints what to do next;
// it never commits, never creates a tag and never pushes.
//
//   npm run release:prepare -- <version> [--date YYYY-MM-DD]
//
//   CHANGELOG.md        "Unreleased" becomes "## [<version>] - <date>", a new
//                       empty "Unreleased" is left above it
//   package.json        "version" (the one source of the gateway version)
//   package-lock.json   the two copies of that version
//   apps/website/src/content/releases.json
//                       the released versions the site serves in versions.json:
//                       { gateway, prerelease, date, plugins: { <id>: <version> } },
//                       every plugins/*/package.json but _template
//
// A plugin hotfix, released alone by a tag plugin-<id>-v<version> (ADR
// plugins-bundled-or-pinned-by-the-operator):
//
//   npm run release:prepare -- --plugin <id>
//
//   apps/website/src/content/releases.json
//                       that plugin's entry alone, to the version of
//                       plugins/<id>/package.json (bumped by hand beforehand)
//
// Policy: docs/workflow/coding-workflow.md ("Release").
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseError,
  assertMovesForward,
  bumpLockfile,
  bumpManifest,
  parseReleasesData,
  parseVersion,
  PLUGIN_TEMPLATE,
  prepareChangelog,
  releasesData,
  serializeReleasesData,
  withPluginRelease,
} from './release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: npm run release:prepare -- <version> [--date YYYY-MM-DD]\n' +
  '       npm run release:prepare -- --plugin <id>';
const RELEASES = 'apps/website/src/content/releases.json';

function parseArguments(argv) {
  const positional = [];
  let date = new Date().toISOString().slice(0, 10);
  let plugin = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--date') {
      date = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--plugin') {
      plugin = argv[index + 1] ?? '';
      index += 1;
      if (plugin === '') throw new ReleaseError(USAGE);
    } else if (argument.startsWith('--')) {
      throw new ReleaseError(`unknown option ${argument}\n${USAGE}`);
    } else {
      positional.push(argument);
    }
  }
  if (plugin !== null) {
    if (positional.length !== 0) throw new ReleaseError(USAGE);
    return { plugin, version: null, date };
  }
  if (positional.length !== 1) throw new ReleaseError(USAGE);
  return { plugin: null, version: positional[0], date };
}

/** The version of every plugin of plugins/ but the template, by id. */
function pluginVersions() {
  const dir = resolve(ROOT, 'plugins');
  if (!existsSync(dir)) return {};
  const versions = {};
  for (const id of readdirSync(dir).sort()) {
    const manifest = join(dir, id, 'package.json');
    if (id === PLUGIN_TEMPLATE || !existsSync(manifest)) continue;
    versions[id] = JSON.parse(readFileSync(manifest, 'utf8')).version;
  }
  return versions;
}

function writeReleases(data) {
  const path = resolve(ROOT, RELEASES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeReleasesData(data));
}

/** `--plugin <id>`: the hotfix of one plugin, released by its own tag. */
function preparePlugin(id) {
  const manifest = resolve(ROOT, 'plugins', id, 'package.json');
  if (id === PLUGIN_TEMPLATE || !existsSync(manifest)) {
    throw new ReleaseError(`no plugin '${id}' in plugins/`);
  }
  const path = resolve(ROOT, RELEASES);
  if (!existsSync(path)) {
    throw new ReleaseError(`${RELEASES} does not exist: a gateway release writes it first`);
  }
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  const before = parseReleasesData(readFileSync(path, 'utf8'));
  const previous = before.plugins[id] ?? 'none';
  writeReleases(withPluginRelease(before, id, version));
  const tag = `plugin-${id}-v${version}`;
  console.log(
    [
      `Prepared plugin ${id} ${version}.`,
      `  ${RELEASES}   ${id}: ${previous} -> ${version}`,
      '',
      'Next, by hand:',
      `  1. Commit it with the plugin's change (plugins/${id}/package.json, its definePlugin`,
      '     version, CHANGELOG.md, and advisories.json when the fix is a security one).',
      '  2. Bring that commit to main through a pull request and wait for CI.',
      '  3. Tag the merged commit and push the tag; it publishes this plugin alone:',
      `       git tag -a ${tag} -m "Vaubaan plugin ${id} ${version}" <commit>`,
      `       git push origin ${tag}`,
      '',
      'No commit and no tag were created.',
    ].join('\n'),
  );
}

function main() {
  const { plugin, version, date } = parseArguments(process.argv.slice(2));
  if (plugin !== null) {
    preparePlugin(plugin);
    return;
  }
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
  const releases = releasesData({ gatewayVersion: next.raw, date, plugins: pluginVersions() });
  writeFileSync(paths.changelog, changelog);
  writeFileSync(paths.manifest, bumpedManifest);
  writeFileSync(paths.lockfile, bumpedLockfile);
  writeReleases(releases);

  const tag = `v${next.raw}`;
  const branch =
    next.prerelease === null ? 'main' : 'main (or v5 until the cutover, pre-releases only)';
  console.log(
    [
      `Prepared ${next.raw} (${date}).`,
      `  CHANGELOG.md        "Unreleased" -> "[${next.raw}] - ${date}"`,
      `  package.json        ${current} -> ${next.raw}`,
      `  package-lock.json   ${current} -> ${next.raw}`,
      `  ${RELEASES}   gateway ${next.raw}, ${Object.keys(releases.plugins).length} plugins`,
      '',
      'Next, by hand:',
      '  1. Review the diff, then commit:',
      `       git add CHANGELOG.md package.json package-lock.json ${RELEASES}`,
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
