/**
 * Builds the published SDK into `dist/`, with its two workspace dependencies inside.
 *
 *   node scripts/build.ts
 *
 * `@vaubaan/shared` and `@vaubaan/policy-engine` are private workspace packages whose
 * `exports` point at TypeScript sources: published as dependencies, the SDK could not be
 * installed. They are compiled into `dist/internal/<name>/` beside the SDK, and every
 * import of them in the emitted JavaScript and declarations is rewritten to a relative
 * path, so the package ships one self-contained tree and they never become public
 * contracts of their own (handbook plugin-sdk, Publication). `publish-manifest.ts apply`
 * drops them from the published `dependencies`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(PACKAGE, 'dist');

/** The workspace packages inlined, by import name, with their compiled root under `dist/`. */
export const INLINED: Readonly<Record<string, string>> = {
  '@vaubaan/shared': 'internal/shared',
  '@vaubaan/policy-engine': 'internal/policy-engine',
};

const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(@vaubaan\/(?:shared|policy-engine))(\/[a-z0-9-]+)?\2/g;

/**
 * Rewrites the inlined packages' specifiers of one emitted file, relative to `file`.
 * Pure. A subpath (`@vaubaan/shared/risk-id`) maps to its module (`…/risk-id.js`).
 */
export function rewriteSpecifiers(source: string, file: string, dist: string): string {
  return source.replace(
    SPECIFIER,
    (_match, lead: string, quote: string, name: string, subpath: string | undefined) => {
      const root = INLINED[name];
      if (root === undefined) return _match;
      const target = join(
        dist,
        root,
        subpath === undefined ? 'index.js' : `${subpath.slice(1)}.js`,
      );
      let path = relative(dirname(file), target).split(sep).join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      return `${lead}${quote}${path}${quote}`;
    },
  );
}

const RELATIVE_TS = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*?)\.ts\2/g;

/**
 * Points a declaration file's relative `.ts` imports at the emitted `.js` modules. Pure.
 * `rewriteRelativeImportExtensions` rewrites the JavaScript only; a consumer resolving
 * `./plugin.ts` inside `dist/` would find no such file.
 */
export function rewriteDeclarationExtensions(source: string): string {
  return source.replace(
    RELATIVE_TS,
    (_match, lead: string, quote: string, path: string) => `${lead}${quote}${path}.js${quote}`,
  );
}

const ANY_VAUBAAN_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]@vaubaan\//;

function emitted(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return emitted(path);
    return path.endsWith('.js') || path.endsWith('.d.ts') ? [path] : [];
  });
}

function main(): void {
  rmSync(DIST, { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const project of [
    'tsconfig.build.json',
    'tsconfig.build.shared.json',
    'tsconfig.build.policy-engine.json',
  ]) {
    execFileSync(process.execPath, [tsc, '-p', project], { cwd: PACKAGE, stdio: 'inherit' });
  }
  const left: string[] = [];
  for (const file of emitted(DIST)) {
    const source = readFileSync(file, 'utf8');
    let rewritten = rewriteSpecifiers(source, file, DIST);
    if (file.endsWith('.d.ts')) rewritten = rewriteDeclarationExtensions(rewritten);
    if (rewritten !== source) writeFileSync(file, rewritten);
    if (ANY_VAUBAAN_IMPORT.test(rewritten)) left.push(relative(PACKAGE, file));
  }
  if (left.length > 0) {
    throw new Error(`an @vaubaan import is left in the build: ${left.join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
