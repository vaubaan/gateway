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
//                       the catalog index's versions, and plugins/*/package.json for
//                       the plugins the catalog does not publish (vaubaan, ssh)
//   apps/website/content/docs/install/on-your-computer.mdx
//                       the image version its commands run
//   apps/gateway/src/server/plugins/catalog-versions.json
//                       the catalog versions this release knows, read from the
//                       catalog's index (--catalog-index <file or https URL>, by
//                       default the published one)
//
// A plugin version is released by the catalog alone, never here (ADR
// plugin-catalog-rebuilt-from-source, amendment 2026-11-19): a pull request on
// vaubaan/gateway-plugins.
//
// Policy: docs/workflow/coding-workflow.md ("Release").
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseError,
  assertMovesForward,
  bumpLockfile,
  bumpImageReferences,
  bumpManifest,
  catalogVersionsFrom,
  parseVersion,
  PLUGIN_TEMPLATE,
  prepareChangelog,
  releasesData,
  serializeReleasesData,
} from './release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: npm run release:prepare -- <version> [--date YYYY-MM-DD] [--catalog-index <file or https URL>]';
const RELEASES = 'apps/website/src/content/releases.json';
const CATALOG_VERSIONS = 'apps/gateway/src/server/plugins/catalog-versions.json';
/** The page whose commands run the image of the release (`bumpImageReferences`). */
const RUN_LOCALLY_PAGE = 'apps/website/content/docs/install/on-your-computer.mdx';
const CATALOG_INDEX_URL = 'https://vaubaan.github.io/gateway-plugins/index.json';
/** The plugins compiled into the server: never in the catalog. */
const COMPILED = ['vaubaan', 'ssh'];
const CATALOG_VERSIONS_COMMENT =
  "The catalog versions this release of the gateway was tested with, each with the service's name and pinned by the sha256 of its archive (ADR plugins-installed-when-first-needed), written by npm run release:prepare from the catalog's index. Nothing here is preinstalled: an instance downloads a version when it needs it — at a person's first connection of the service when the catalog index names no newer one, and at a start for the plugins its accounts need — and keeps it only if the sha256 matches and the catalog signed it.";

function parseArguments(argv) {
  const positional = [];
  let date = new Date().toISOString().slice(0, 10);
  let catalogIndex = CATALOG_INDEX_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--date') {
      date = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--catalog-index') {
      catalogIndex = argv[index + 1] ?? '';
      index += 1;
      if (catalogIndex === '') throw new ReleaseError(USAGE);
    } else if (argument === '--plugin') {
      throw new ReleaseError(
        'a plugin version is released by the catalog alone: open a pull request on vaubaan/gateway-plugins that moves its declaration (docs/workflow/coding-workflow.md, "Plugin releases")',
      );
    } else if (argument.startsWith('--')) {
      throw new ReleaseError(`unknown option ${argument}\n${USAGE}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) throw new ReleaseError(USAGE);
  return { version: positional[0], date, catalogIndex };
}

/** The catalog's index, from a file or an https URL. */
async function readCatalogIndex(where) {
  let text;
  if (where.startsWith('https://')) {
    let response;
    try {
      response = await fetch(where, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new ReleaseError(`the catalog index ${where} could not be read: ${error.message}`);
    }
    if (!response.ok) {
      throw new ReleaseError(`the catalog index ${where} answered HTTP ${response.status}`);
    }
    text = await response.text();
  } else {
    if (!existsSync(resolve(ROOT, where))) {
      throw new ReleaseError(`no catalog index at ${where}`);
    }
    text = readFileSync(resolve(ROOT, where), 'utf8');
  }
  /** @type {unknown} */
  let index;
  try {
    index = JSON.parse(String(text));
  } catch {
    throw new ReleaseError(`the catalog index ${where} is not JSON`);
  }
  return index;
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

async function main() {
  const { version, date, catalogIndex } = parseArguments(process.argv.slice(2));
  const paths = {
    changelog: resolve(ROOT, 'CHANGELOG.md'),
    manifest: resolve(ROOT, 'package.json'),
    lockfile: resolve(ROOT, 'package-lock.json'),
    runLocally: resolve(ROOT, RUN_LOCALLY_PAGE),
  };
  const manifest = readFileSync(paths.manifest, 'utf8');
  const current = JSON.parse(manifest).version;
  const next = parseVersion(version);
  assertMovesForward(current, next.raw);

  // Compute everything before writing anything: a refusal leaves the tree untouched.
  const changelog = prepareChangelog(readFileSync(paths.changelog, 'utf8'), next.raw, date);
  const bumpedManifest = bumpManifest(manifest, next.raw);
  const bumpedLockfile = bumpLockfile(readFileSync(paths.lockfile, 'utf8'), next.raw);
  const runLocally = existsSync(paths.runLocally)
    ? bumpImageReferences(readFileSync(paths.runLocally, 'utf8'), next.raw)
    : null;
  const known = catalogVersionsFrom(
    await readCatalogIndex(catalogIndex),
    CATALOG_VERSIONS_COMMENT,
    COMPILED,
  );
  const releases = releasesData({
    gatewayVersion: next.raw,
    date,
    plugins: {
      ...pluginVersions(),
      ...Object.fromEntries(Object.entries(known.plugins).map(([id, p]) => [id, p.version])),
    },
  });
  writeFileSync(paths.changelog, changelog);
  writeFileSync(paths.manifest, bumpedManifest);
  writeFileSync(paths.lockfile, bumpedLockfile);
  if (runLocally !== null) writeFileSync(paths.runLocally, runLocally);
  writeReleases(releases);
  const catalogVersionsPath = resolve(ROOT, CATALOG_VERSIONS);
  mkdirSync(dirname(catalogVersionsPath), { recursive: true });
  writeFileSync(catalogVersionsPath, `${JSON.stringify(known, null, 2)}\n`);

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
      `  ${CATALOG_VERSIONS}   ${Object.keys(known.plugins).length} catalog plugins, from ${catalogIndex}`,
      ...(runLocally !== null ? [`  ${RUN_LOCALLY_PAGE}   image ${next.raw}`] : []),
      '',
      'Next, by hand:',
      '  1. Review the diff, then commit:',
      `       git add CHANGELOG.md package.json package-lock.json ${RELEASES} ${CATALOG_VERSIONS}${runLocally !== null ? ` ${RUN_LOCALLY_PAGE}` : ''}`,
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

main().catch((error) => {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`release:prepare: ${error.message}`);
  process.exit(1);
});
