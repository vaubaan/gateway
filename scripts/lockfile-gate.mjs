#!/usr/bin/env node
/**
 * Lockfile gate (CI job "audit"; the release pipeline calls ci.yml, so it
 * gates releases too).
 *
 *   node scripts/lockfile-gate.mjs [package-lock.json]
 *
 * What `npm ci` installs is exactly package-lock.json, so the lockfile is
 * where a dependency could be pointed somewhere else: a tarball on another
 * host, a git URL, plain http, an entry without its hash, a name whose
 * tarball is another package's. Every installed entry must:
 *
 *   - come from https://registry.npmjs.org/ (the one registry; no mirror, no
 *     git, no file, no http);
 *   - carry a sha512 `integrity`, which npm checks against the tarball;
 *   - download the package it names: the tarball path is the entry's name
 *     (an `npm:` alias keeps its real name in `name`);
 *
 * and the entries that are not downloaded must be this repository's own
 * workspaces (a `link` to a path inside the repository, or the workspace
 * folder itself). Exit 1 with one line per offending entry; 2 when the
 * lockfile cannot be read.
 *
 * The same checks as the lockfile-lint package, written here so the gate adds
 * no dependency to the supply chain it guards (ADR
 * supply-chain-and-ci-security-checks). `checkLockfile()` is pure and
 * unit-tested (scripts/lockfile-gate.test.mjs).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org/';
const NODE_MODULES = 'node_modules/';

/**
 * The package name an entry key installs: what follows its last `node_modules/`.
 * @param {string} key
 * @returns {string | null}
 */
export function nameOfKey(key) {
  const at = key.lastIndexOf(NODE_MODULES);
  return at === -1 ? null : key.slice(at + NODE_MODULES.length);
}

/**
 * The package name a registry tarball URL downloads (`/<name>/-/<file>.tgz`), or null.
 * @param {string} url
 * @returns {string | null}
 */
export function nameOfTarball(url) {
  const { pathname } = new URL(url);
  const at = pathname.indexOf('/-/');
  if (at <= 0) return null;
  return decodeURIComponent(pathname.slice(1, at));
}

/** A relative path that stays inside the repository. */
function insideRepository(path) {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !path.split('/').includes('..')
  );
}

/** @typedef {{ key: string, problem: string }} Problem */

/**
 * Every problem of a parsed package-lock.json (lockfile version 2 or 3), as
 * `{ key, problem }`; an empty list means the lockfile passes.
 * @param {any} lock
 * @returns {Problem[]}
 */
export function checkLockfile(lock) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {(key: string, problem: string) => void} */
  const add = (key, problem) => {
    problems.push({ key, problem });
  };
  if (lock === null || typeof lock !== 'object' || typeof lock.packages !== 'object') {
    return [{ key: '', problem: 'no "packages" map: lockfileVersion 2 or 3 is required' }];
  }
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    add('', `lockfileVersion ${String(lock.lockfileVersion)} is not 2 or 3`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue; // the root project
    const name = nameOfKey(key);
    if (entry.link === true) {
      if (!insideRepository(entry.resolved)) {
        add(key, `links to ${String(entry.resolved)}, outside the repository`);
      }
      continue;
    }
    if (name === null) {
      // A workspace folder: its own sources, never downloaded.
      if (!insideRepository(key)) add(key, 'a workspace outside the repository');
      if (entry.resolved !== undefined) add(key, `a workspace with a download (${entry.resolved})`);
      continue;
    }
    if (typeof entry.resolved !== 'string') {
      add(key, 'no "resolved": where it comes from is not recorded');
      continue;
    }
    if (!entry.resolved.startsWith(REGISTRY)) {
      add(key, `resolved from ${entry.resolved}, not from ${REGISTRY}`);
      continue;
    }
    if (
      typeof entry.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
    ) {
      add(key, 'no sha512 "integrity": the tarball would be installed unchecked');
    }
    const expected = typeof entry.name === 'string' ? entry.name : name;
    const downloaded = nameOfTarball(entry.resolved);
    if (downloaded !== expected) {
      add(key, `downloads ${String(downloaded)}, not ${expected}`);
    }
  }
  return problems;
}

function main(args) {
  const path = resolve(args[0] ?? 'package-lock.json');
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(
      `lockfile-gate: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  const problems = checkLockfile(lock);
  for (const { key, problem } of problems) {
    console.error(`::error title=Lockfile gate::${key || 'package-lock.json'}: ${problem}`);
  }
  if (problems.length > 0) return 1;
  const count = Object.keys(lock.packages).length - 1;
  console.log(
    `lockfile-gate: ${count} entries, every download from ${REGISTRY} with a sha512 integrity.`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
