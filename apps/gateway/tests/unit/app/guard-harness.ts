/**
 * Shared by the guard tests of the two human surfaces (`(app)` and
 * `/admin`): find the pages and routes of a surface on disk, call a page as
 * the plain async function it is, and name how Next's control-flow errors
 * ended it. No browser, no `next` runtime.
 *
 * `next/headers` is replaced by each test file (a `vi.mock` is hoisted per
 * file), so nothing here reads the request.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a directory under `apps/gateway/src/app`. */
export function appDir(segment: string): string {
  return resolve(HERE, '../../../src/app', segment);
}

export interface SurfaceFile {
  readonly path: string;
  /** Path relative to the surface directory, as test titles show it. */
  readonly name: string;
}

function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesNamed(path, name);
    return entry.name === name ? [path] : [];
  });
}

/** Every file called `name` below `dir`, sorted by relative path. */
export function surfaceFiles(dir: string, name: string): SurfaceFile[] {
  return filesNamed(dir, name)
    .map((path) => ({ path, name: relative(dir, path) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type Outcome =
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * The `root` a guard returned, for a `toBe` against the test's root. Never put
 * the root in a `toMatchObject`: it walks the expected object key by key even
 * when it is the very same reference, so the whole composition root (store,
 * services, every plugin) costs about 8 s per assertion.
 */
export function returnedRoot(outcome: Outcome): unknown {
  if (outcome.kind !== 'returned') return undefined;
  const { value } = outcome;
  return typeof value === 'object' && value !== null && 'root' in value ? value.root : undefined;
}

/** Runs a server function and names how Next's control-flow errors ended it. */
export async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: 'returned', value: await run() };
  } catch (error) {
    const digest =
      typeof error === 'object' && error !== null && 'digest' in error ? String(error.digest) : '';
    if (digest.startsWith('NEXT_REDIRECT;')) {
      return { kind: 'redirect', to: digest.split(';')[2] ?? '' };
    }
    if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return { kind: 'not-found' };
    return { kind: 'threw', error };
  }
}

type PageModule = { default: (props: Record<string, unknown>) => Promise<unknown> };

/** Calls the default export of a `page.tsx` with empty search params and the given params. */
export async function renderPage(
  path: string,
  params: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
  const page = (await import(/* @vite-ignore */ path)) as PageModule;
  return outcomeOf(() =>
    page.default({ searchParams: Promise.resolve({}), params: Promise.resolve(params) }),
  );
}
