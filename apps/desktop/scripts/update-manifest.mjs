#!/usr/bin/env node
// Writes the update manifest of a release, `latest.json`, that Tauri's updater reads (ADR
// desktop-app-updated-by-the-tauri-updater-from-the-github-release):
//
//   { version, notes, pub_date, security,
//     platforms: { "darwin-aarch64": { signature, url }, "darwin-x86_64": { signature, url } } }
//
//   node apps/desktop/scripts/update-manifest.mjs --version 2.0.0-alpha.33 \
//     --repository vaubaan/gateway --dir <folder holding the archives and their .sig> --out latest.json
//
// The archives are `Vaubaan-<version>-<arm64|x64>.app.tar.gz`, each beside its `.sig` (the
// updater key's signature, written by `tauri build`). The notes are the version's CHANGELOG.md
// section, as plain text short enough for a dialog, with the link to the whole release. The
// release fixes a security issue (`security: true`) when its section has a "### Security"
// heading or the site's advisories name a gateway advisory it fixes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractReleaseNotes, parseVersion } from '../../../scripts/release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const ADVISORIES = join(ROOT, 'apps/website/src/content/advisories.json');

/** The architectures the app is built for: the updater's platform key and the file's suffix. */
export const UPDATE_PLATFORMS = Object.freeze([
  { platform: 'darwin-aarch64', arch: 'arm64' },
  { platform: 'darwin-x86_64', arch: 'x64' },
]);

/** The most characters of notes a dialog shows; the rest is behind the release's link. */
export const NOTES_MAX_CHARS = 1200;

/** @param {string} version @param {string} arch */
export function archiveName(version, arch) {
  return `Vaubaan-${version}-${arch}.app.tar.gz`;
}

/**
 * Markdown made plain for a native dialog: no emphasis, no code marks, a link keeps its text.
 * @param {string} markdown
 */
export function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{2,}\s+(.*)$/gm, '$1:')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The notes the dialog shows: the section's "Highlights" when it has some, else the whole
 * section; cut at a line under `NOTES_MAX_CHARS`, then the link to the release.
 * @param {string} sectionNotes the version's CHANGELOG.md section (extractReleaseNotes)
 * @param {string} releaseUrl
 */
export function updateNotes(sectionNotes, releaseUrl) {
  const highlights = /^### Highlights\s*\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/m.exec(sectionNotes);
  const text = plainText(highlights ? highlights[1] : sectionNotes);
  let kept = text;
  if (text.length > NOTES_MAX_CHARS) {
    const cut = text.lastIndexOf('\n', NOTES_MAX_CHARS);
    kept = `${text.slice(0, cut > 0 ? cut : NOTES_MAX_CHARS).trimEnd()}\n…`;
  }
  return `${kept}\n\nAll the notes: ${releaseUrl}`;
}

/**
 * Whether the release fixes a security issue: a "### Security" heading in its section, or a
 * gateway advisory of the versions feed fixed by this version.
 * @param {string} sectionNotes
 * @param {unknown} advisories the site's advisories.json
 * @param {string} version
 */
export function isSecurityRelease(sectionNotes, advisories, version) {
  if (/^### Security\s*$/m.test(sectionNotes)) return true;
  if (!Array.isArray(advisories)) return false;
  return advisories.some(
    (advisory) =>
      typeof advisory === 'object' &&
      advisory !== null &&
      advisory.subject === 'gateway' &&
      advisory.fixed === version,
  );
}

/**
 * The manifest; throws when an architecture's archive or signature is missing, so a release
 * never offers an update half its users cannot install.
 * @param {{ version: string, repository: string, dir: string, changelog: string,
 *   advisories: unknown, date: Date }} input
 */
export function buildManifest({ version, repository, dir, changelog, advisories, date }) {
  parseVersion(version);
  const tag = `v${version}`;
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const section = extractReleaseNotes(changelog, version);
  const platforms = {};
  for (const { platform, arch } of UPDATE_PLATFORMS) {
    const name = archiveName(version, arch);
    const signature = join(dir, `${name}.sig`);
    if (!existsSync(join(dir, name)) || !existsSync(signature)) {
      throw new Error(`${name} or its .sig is missing from ${dir}: no update manifest`);
    }
    platforms[platform] = {
      signature: readFileSync(signature, 'utf8').trim(),
      url: `${base}/${name}`,
    };
  }
  return {
    version,
    notes: updateNotes(section, `https://github.com/${repository}/releases/tag/${tag}`),
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    security: isSecurityRelease(section, advisories, version),
    platforms,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const version = argument('--version');
  const repository = argument('--repository');
  const dir = argument('--dir');
  const out = argument('--out');
  if (!version || !repository || !dir || !out) {
    throw new Error(
      'usage: update-manifest.mjs --version <x.y.z> --repository <owner/name> --dir <dir> --out <file>',
    );
  }
  const manifest = buildManifest({
    version,
    repository,
    dir,
    changelog: readFileSync(CHANGELOG, 'utf8'),
    advisories: JSON.parse(readFileSync(ADVISORIES, 'utf8')),
    date: new Date(),
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out}: ${version}, security ${manifest.security}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
