/**
 * Where the repository is, for the build-time generator and the tests. Pages
 * never import this module: they read what the generator wrote.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The monorepo's root: `apps/website/src/content` is four levels below it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The website workspace (`apps/website`). */
export const WEBSITE_ROOT = resolve(REPO_ROOT, 'apps/website');

export function repoPath(relative: string): string {
  return resolve(REPO_ROOT, relative);
}

export function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8');
}
