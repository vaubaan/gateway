#!/usr/bin/env node
// What a plugin release tag publishes (.github/workflows/release.yml, job
// `plugin-release`; ADR plugins-bundled-or-pinned-by-the-operator):
//
//   node scripts/plugin-release-plan.mjs --tag plugin-<id>-v<version>
//
// Refuses a tag that is not plugin-<id>-v<version>, that names no plugin of
// plugins/ (or the template), whose version is not the one of
// plugins/<id>/package.json, or whose plugin is not bundleable (its package.json
// says "vaubaan": { "bundleable": false }). Writes `id` and `version` to
// $GITHUB_OUTPUT when set. Runs the same on a laptop.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notBundleableReason } from './build-plugin-bundle.mjs';
import { ReleaseError, assertPluginTag, parsePluginTag } from './release-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/plugin-release-plan.mjs --tag plugin-<id>-v<version>';

function main() {
  const [flag, tag, ...rest] = process.argv.slice(2);
  if (flag !== '--tag' || !tag || rest.length > 0) throw new ReleaseError(USAGE);
  const manifestPath = resolve(ROOT, 'plugins', parsePluginTag(tag).id, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const { id, version } = assertPluginTag({ tag, manifestVersion: manifest?.version ?? null });
  const reason = notBundleableReason(manifest);
  if (reason !== null) {
    throw new ReleaseError(
      `plugin ${id} is not bundleable (${reason}): it ships with the image only`,
    );
  }
  console.log(`Plugin ${id} ${version}: publishes the image plugin-${id}:${version}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `id=${id}\nversion=${version}\n`);
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`::error title=Plugin release refused::${error.message}`);
  process.exit(1);
}
