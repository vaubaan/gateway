#!/usr/bin/env node
// Assembles what the desktop app bundles beside its shell (ADR
// desktop-app-tauri-shell-over-the-node-standalone-server), for one target:
//
//   src-tauri/resources/gateway/      the gateway's standalone output, as the image copies it
//                                     (server, traced node_modules, .next/static, public)
//   src-tauri/binaries/node-<target>  the official Node binary of the image's version,
//                                     checked against nodejs.org's SHASUMS256.txt
//
//   node apps/desktop/scripts/assemble.mjs --target aarch64-apple-darwin
//
// Run after `npm run build --workspace @vaubaan/gateway-app` on a machine of the
// target's system and architecture: Next traces the native addons' binaries of the
// platform that builds (apps/gateway/next.config.ts). The Node version is the one the
// Dockerfile pins, so the app and the image run the same runtime.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DESKTOP = join(ROOT, 'apps/desktop/src-tauri');
const GATEWAY = join(ROOT, 'apps/gateway');
const DOCKERFILE = join(ROOT, 'deploy/docker/Dockerfile');

/** Rust target triple → Node's platform and architecture, and where the addons look. */
const TARGETS = {
  'aarch64-apple-darwin': { node: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { node: 'darwin-x64', platform: 'darwin', arch: 'x64' },
};

function fail(message) {
  console.error(`assemble: ${message}`);
  process.exit(1);
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * `FROM node:26.13.1-bookworm-slim@sha256:...` → `26.13.1`.
 * @param {string} dockerfile
 * @returns {string}
 */
export function nodeVersionOf(dockerfile) {
  const match = /^FROM node:(\d+\.\d+\.\d+)-/m.exec(dockerfile);
  if (!match) throw new Error('the Dockerfile names no node:<version> base image');
  return match[1];
}

/**
 * The expected sha256 of one file in a SHASUMS256.txt.
 * @param {string} shasums
 * @param {string} file
 * @returns {string}
 */
export function checksumOf(shasums, file) {
  for (const line of shasums.split('\n')) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name === file && /^[0-9a-f]{64}$/.test(sum ?? '')) return sum;
  }
  throw new Error(`SHASUMS256.txt lists no ${file}`);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function copyGateway(target) {
  const standalone = join(GATEWAY, '.next/standalone');
  if (!existsSync(join(standalone, 'apps/gateway/server.js'))) {
    fail(
      'apps/gateway/.next/standalone is missing: run npm run build --workspace @vaubaan/gateway-app first',
    );
  }
  const out = join(DESKTOP, 'resources/gateway');
  rmSync(out, { recursive: true, force: true });
  cpSync(standalone, out, { recursive: true, verbatimSymlinks: true });
  cpSync(join(GATEWAY, '.next/static'), join(out, 'apps/gateway/.next/static'), {
    recursive: true,
  });
  cpSync(join(GATEWAY, 'public'), join(out, 'apps/gateway/public'), { recursive: true });
  // The native addons this target loads must be in the tree: a build made elsewhere
  // would start and then fail at the first store access.
  const sqlite = join(
    out,
    `node_modules/better-sqlite3/prebuilds/${target.platform}-${target.arch}.node`,
  );
  if (!existsSync(sqlite))
    fail(`no better-sqlite3 binary for ${target.node}: build on that system`);
  const argon2 = [
    join(out, `node_modules/argon2/prebuilds/${target.platform}-${target.arch}`),
    join(out, 'node_modules/argon2/build/Release/argon2.node'),
  ];
  if (!argon2.some((path) => existsSync(path))) fail(`no argon2 binary for ${target.node}`);
  return out;
}

async function fetchNode(version, target, triple) {
  const base = `https://nodejs.org/dist/v${version}`;
  const archive = `node-v${version}-${target.node}.tar.gz`;
  const expected = checksumOf((await download(`${base}/SHASUMS256.txt`)).toString('utf8'), archive);
  const bytes = await download(`${base}/${archive}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) fail(`${archive}: sha256 ${actual}, SHASUMS256.txt says ${expected}`);
  const work = join(tmpdir(), `vaubaan-node-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tarball = join(work, archive);
  writeFileSync(tarball, bytes);
  const member = `node-v${version}-${target.node}/bin/node`;
  execFileSync('tar', ['-xzf', tarball, '-C', work, member]);
  const binary = join(DESKTOP, `binaries/node-${triple}`);
  mkdirSync(dirname(binary), { recursive: true });
  cpSync(join(work, member), binary);
  chmodSync(binary, 0o755);
  rmSync(work, { recursive: true, force: true });
  return binary;
}

async function main() {
  const triple = argument('--target');
  const target = triple === undefined ? undefined : TARGETS[triple];
  if (!target) fail(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
  const version = nodeVersionOf(readFileSync(DOCKERFILE, 'utf8'));
  const gateway = copyGateway(target);
  const node = await fetchNode(version, target, triple);
  console.log(`assembled for ${triple}: Node ${version} at ${node}, the gateway at ${gateway}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
