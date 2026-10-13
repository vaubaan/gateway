/**
 * The route table the authorization-server tests drive (`ROUTES` in
 * `support.ts`) is the application's: every entry names a route file that
 * exists and delegates to that very handler, and every route file of the
 * OAuth surface is in the table.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ROUTES } from './support';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/app');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [relative(APP, path)] : [];
  });
}

/** `/oauth/authorize/decision` ← `oauth/authorize/decision/route.ts`; `(group)` segments vanish, `[id]` is `:id`. */
function pathOf(file: string): string {
  const segments = dirname(file)
    .split('/')
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(.+)\]$/, ':$1'));
  return `/${segments.join('/')}`;
}

describe('the route table of the authorization-server tests', () => {
  it.each(ROUTES)('$path is served by $file, which delegates to $delegatesTo', (route) => {
    const source = readFileSync(join(APP, route.file), 'utf8');
    expect(pathOf(route.file)).toBe(route.path);
    expect(source).toContain(`(await getRoot()).${route.delegatesTo}(request`);
  });

  it('contains every route that delegates to the authorization server or the management door', () => {
    const delegating = routeFiles(APP).filter((file) =>
      /\.(?:oauth|management)\.handlers\./.test(readFileSync(join(APP, file), 'utf8')),
    );
    expect(delegating.sort()).toEqual(
      ROUTES.filter((route) => /^(?:oauth|management)\./.test(route.delegatesTo))
        .map((route) => route.file)
        .sort(),
    );
  });

  it('exports the HTTP methods each endpoint answers', () => {
    const methodsOf = (file: string): string[] => {
      const source = readFileSync(join(APP, file), 'utf8');
      const named = [...source.matchAll(/export async function ([A-Z]+)\b/g)].map((m) => m[1]);
      const aliased = [...source.matchAll(/handle as ([A-Z]+)\b/g)].map((m) => m[1]);
      return [...named, ...aliased].filter((m): m is string => m !== undefined).sort();
    };
    expect(methodsOf('oauth/authorize/route.ts')).toEqual(['GET']);
    expect(methodsOf('oauth/authorize/decision/route.ts')).toEqual(['POST']);
    for (const file of [
      'oauth/token/route.ts',
      'oauth/register/route.ts',
      'oauth/revoke/route.ts',
    ]) {
      expect(methodsOf(file)).toEqual(['OPTIONS', 'POST']);
    }
    for (const file of [
      '.well-known/oauth-authorization-server/route.ts',
      '.well-known/oauth-protected-resource/mcp/manage/route.ts',
    ]) {
      expect(methodsOf(file)).toEqual(['GET', 'HEAD', 'OPTIONS']);
    }
    expect(methodsOf('mcp/manage/route.ts')).toEqual(['DELETE', 'GET', 'POST']);
  });
});
