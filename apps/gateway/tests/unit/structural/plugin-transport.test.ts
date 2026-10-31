/**
 * Structural test (ADR plugin-contract-and-credential-spec, amendment of
 * 2026-10-31): a plugin reads its provider's answers through the SDK's
 * transport (`httpJson`, `readBounded`, `callUpstreamTool`), never by
 * calling `.json()` or `.text()` on a response itself. The transport is
 * where the size bound, the 401 / 403 rule and the guard of an untrusted
 * answer are written once; a plugin's own read skips all three.
 *
 * The plugins written before the transport existed still read bodies
 * themselves. They are listed below, and the list only shrinks: a plugin
 * not on it that reads a body fails, and a listed plugin that no longer
 * does fails too, so its migration takes it off the list in the same change.
 * Read with the TypeScript parser: a zero-argument call of a member named
 * `json` or `text`, in every source file of every plugin folder.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PLUGINS = join(REPO, 'plugins');

/** The plugins still on their own reads, until the migration wave moves them to the transport. */
const NOT_YET_ON_THE_TRANSPORT: readonly string[] = [
  'context7',
  'github',
  'notion',
  'railway',
  'supabase',
  'upstash-redis',
  'vercel',
];

const BODY_READS = new Set(['json', 'text']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** `file:line` of every `<expression>.json()` / `<expression>.text()` in a file. */
function bodyReadsIn(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      BODY_READS.has(node.expression.name.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path.slice(REPO.length + 1)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const plugins = readdirSync(PLUGINS).filter((name) => {
  try {
    return statSync(join(PLUGINS, name, 'src')).isDirectory();
  } catch {
    return false;
  }
});

describe('plugins read their provider through the SDK transport', () => {
  it('finds the plugin folders', () => {
    expect(plugins.length).toBeGreaterThan(1);
    expect(plugins).toContain('_template');
  });

  it.each(plugins.filter((p) => !NOT_YET_ON_THE_TRANSPORT.includes(p)))(
    '%s reads no response body itself',
    (plugin) => {
      expect(sourceFiles(join(PLUGINS, plugin, 'src')).flatMap(bodyReadsIn)).toEqual([]);
    },
  );

  it.each(NOT_YET_ON_THE_TRANSPORT)(
    '%s is listed as not yet migrated only while it still reads a body itself',
    (plugin) => {
      expect(plugins).toContain(plugin);
      expect(sourceFiles(join(PLUGINS, plugin, 'src')).flatMap(bodyReadsIn)).not.toEqual([]);
    },
  );
});
