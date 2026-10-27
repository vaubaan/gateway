/**
 * Whether the build under `apps/gateway/.next` is the build of the sources as
 * they are now (handbook demo-mode, Traps).
 *
 * `npm run demo` used to build on every start. It now leaves a stamp next to
 * the build it made — a digest of every file a build reads — and serves that
 * build again as long as the digest of the tree still equals it. A build made
 * by anything else (`npm run build`, the CI) carries no stamp and is rebuilt
 * once, unless `DEMO_SKIP_BUILD=1` says to serve it as it is.
 *
 * The digest is over contents, not dates: a checkout that rewrites a file with
 * the same bytes does not cost a build, and an edit always does.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Name of the stamp, inside the build directory: it goes away with the build. */
export const BUILD_STAMP_FILE = 'demo-build-stamp';

/** Directories a build never reads, wherever they are. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'tests', '.turbo']);

/**
 * What a build of the application reads, relative to the repository root: the
 * application itself, the workspace packages and plugins it bundles (sources
 * and catalogs), and the lockfile that pins everything else.
 */
export const BUILD_INPUTS = [
  'apps/gateway/src',
  'apps/gateway/public',
  'apps/gateway/migrations',
  'apps/gateway/next.config.ts',
  'apps/gateway/package.json',
  'apps/gateway/tsconfig.json',
  'packages',
  'plugins',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
] as const;

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesUnder(join(path, entry.name));
    }
    return entry.isFile() ? [join(path, entry.name)] : [];
  });
}

/** Digest of every build input under `repoRoot`: paths and contents, in a fixed order. */
export function sourceDigest(repoRoot: string, inputs: readonly string[] = BUILD_INPUTS): string {
  const hash = createHash('sha256');
  const files = inputs.flatMap((input) => filesUnder(resolve(repoRoot, input))).sort();
  for (const file of files) {
    hash.update(relative(repoRoot, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const stampPath = (buildDir: string): string => join(buildDir, BUILD_STAMP_FILE);

/** The digest the build under `buildDir` was stamped with, or `null` when it carries none. */
export function readBuildStamp(buildDir: string): string | null {
  try {
    return readFileSync(stampPath(buildDir), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeBuildStamp(buildDir: string, digest: string): void {
  writeFileSync(stampPath(buildDir), `${digest}\n`);
}

/** True when `buildDir` holds a build stamped with the digest of the sources as they are. */
export function buildIsFresh(buildDir: string, digest: string): boolean {
  return existsSync(join(buildDir, 'BUILD_ID')) && readBuildStamp(buildDir) === digest;
}
