#!/usr/bin/env node
/**
 * The socle, into the image (deploy/socle.json; ADR plugin-catalog-rebuilt-from-source).
 *
 *   node scripts/fetch-socle.mjs <out dir>
 *
 * For each entry: downloads the release asset `<id>-v<version>.tgz` of the catalog, checks
 * its sha256 against the one socle.json pins (a moved or replaced asset fails the build),
 * and unpacks it into `<out dir>/<id>/`. The archive is a plain gzipped tar
 * (`@vaubaan/plugin-sdk/archive`), unpacked by the system's tar with no owner, no
 * permission and nothing outside its folder kept. The signature is not checked here: the
 * gateway checks it at every start (apps/gateway/src/server/plugins/socle.ts), and the
 * pinned digest already ties the build to what the catalog published.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CATALOG = 'https://github.com/vaubaan/gateway-plugins/releases/download/';
const ID = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/fetch-socle.mjs <out dir>');
  process.exit(2);
}

/** @type {{ plugins: { id: string, version: string, sha256: string }[] }} */
const socle = JSON.parse(readFileSync(join(ROOT, 'deploy/socle.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const { id, version, sha256 } of socle.plugins) {
  if (!ID.test(id) || !VERSION.test(version) || !SHA256.test(sha256)) {
    throw new Error(
      `deploy/socle.json: ${JSON.stringify({ id, version, sha256 })} is not an entry`,
    );
  }
  const tag = `${id}-v${version}`;
  const url = `${CATALOG}${tag}/${tag}.tgz`;
  const response = await fetch(url, { headers: { 'user-agent': 'vaubaan-gateway-build' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) {
    throw new Error(`${tag}.tgz has sha256 ${digest}, deploy/socle.json pins ${sha256}`);
  }
  const dir = join(out, id);
  mkdirSync(dir);
  const archive = join(out, `.${tag}.tgz`);
  writeFileSync(archive, bytes);
  const tar = spawnSync(
    'tar',
    ['-xzf', archive, '-C', dir, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'],
    { stdio: 'inherit' },
  );
  rmSync(archive);
  if (tar.status !== 0) throw new Error(`${tag}.tgz did not unpack`);
  console.log(`socle: ${id} ${version} (${sha256.slice(0, 12)})`);
}
