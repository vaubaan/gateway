/**
 * Structural test (ADR plugin-contract-and-credential-spec, amendment of
 * 2026-10-31): a plugin reads its service's answers through the SDK's
 * transport (`httpJson`, `readBounded`, `readShape`, the upstream MCP
 * client), never by calling `.json()` or `.text()` on a response itself, and
 * never casts what it read into a service type. The transport is where the
 * size bound, the 401 / 403 rule and the guard of an untrusted answer are
 * written once; a plugin's own read skips all three, and a cast turns a shape
 * change at the service into a `TypeError` deep in `execute` instead of the
 * service's failure.
 *
 * Read with the TypeScript parser over every source file of every plugin
 * folder, the template included:
 *   - a zero-argument call of a member named `json` or `text`;
 *   - a type assertion (`x as FooDto`, `<FooDto>x`) to a type whose name ends
 *     in `Dto`, the plugins' name for the shape of a service's answer.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { eachNode, parsed, PLUGIN_FOLDERS, sourceFilesOf, where } from './plugin-sources';

const BODY_READS = new Set(['json', 'text']);

/** `<expression>.json()` / `<expression>.text()`. */
function isBodyRead(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    BODY_READS.has(node.expression.name.text)
  );
}

/** `x as FooDto`, `x as readonly FooDto[]`, `<FooDto>x`. */
function isDtoCast(source: ts.SourceFile, node: ts.Node): boolean {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  return /\b[A-Za-z]+Dto\b/.test(node.type.getText(source));
}

type Finder = (source: ts.SourceFile, node: ts.Node) => boolean;

function countIn(source: ts.SourceFile, found: Finder): number {
  let count = 0;
  eachNode(source, (node) => {
    if (found(source, node)) count += 1;
  });
  return count;
}

function findingsIn(folder: string, found: Finder): string[] {
  const lines: string[] = [];
  for (const path of sourceFilesOf(folder)) {
    const source = parsed(path);
    eachNode(source, (node) => {
      if (found(source, node)) lines.push(where(source, node));
    });
  }
  return lines;
}

describe('plugins read their service through the SDK transport', () => {
  it('finds the plugin folders, the template among them', () => {
    expect(PLUGIN_FOLDERS).toContain('_template');
    expect(PLUGIN_FOLDERS.length).toBeGreaterThan(1);
  });

  it('the checks read a body read and a DTO cast, and nothing else', () => {
    const source = ts.createSourceFile(
      'sample.ts',
      [
        'const a = await res.json();',
        'const b = await res.text();',
        'const c = JSON.stringify(x);',
        'const d = body as RepositoryDto[];',
        'const e = <ZoneDto>body;',
        'const f = args as Record<string, unknown>;',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(countIn(source, (_source, node) => isBodyRead(node))).toBe(2);
    expect(countIn(source, isDtoCast)).toBe(2);
  });

  it.each(PLUGIN_FOLDERS)('%s reads no response body itself', (folder) => {
    expect(findingsIn(folder, (_source, node) => isBodyRead(node))).toEqual([]);
  });

  it.each(PLUGIN_FOLDERS)("%s casts no service's answer to a DTO", (folder) => {
    expect(findingsIn(folder, isDtoCast)).toEqual([]);
  });
});
