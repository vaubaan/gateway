/**
 * Structural test (ADR plugin-identifiers-one-grammar-for-classify-and-execute;
 * `plugins/README.md`, step 4): an identifier the slice grammar cannot carry
 * is written as "any" with the SDK's `identSegment` / `ANY_IDENT`, never
 * repaired. A plugin that defines its own `ANY_IDENT` has a second meaning
 * of "every instance" to keep in step with the SDK's; a plugin that replaces
 * the characters an identifier may not hold names, in the slice, an
 * identifier that does not exist (the audit line and the refusal an agent
 * reads lie, and a pattern written for the real name no longer matches).
 *
 * Read with the TypeScript parser over every source file of every plugin
 * folder: a declaration named `ANY_IDENT`, and a `.replace` / `.replaceAll`
 * whose pattern is a negated class of identifier characters (letters and
 * digits: `/[^a-zA-Z0-9_./~-]/g`), are refused. A negated class of another
 * kind (`/[^\x20-\x7e]/`, which makes a text printable) is not an identifier.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { eachNode, parsed, PLUGIN_FOLDERS, sourceFilesOf, where } from './plugin-sources';

/** A negated character class that lists letters and digits: the complement of an identifier grammar. */
const NEGATED_IDENTIFIER_CLASS = /\[\^(?=[^\]]*(?:a-z|A-Z))(?=[^\]]*0-9)[^\]]*\]/;

const REPLACERS = new Set(['replace', 'replaceAll']);

function localAnyIdents(folder: string): string[] {
  const found: string[] = [];
  for (const path of sourceFilesOf(folder)) {
    const source = parsed(path);
    eachNode(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'ANY_IDENT'
      ) {
        found.push(where(source, node));
      }
    });
  }
  return found;
}

function identifierRepairs(folder: string): string[] {
  const found: string[] = [];
  for (const path of sourceFilesOf(folder)) {
    const source = parsed(path);
    eachNode(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (!REPLACERS.has(node.expression.name.text)) return;
      const pattern = node.arguments[0];
      if (
        pattern &&
        ts.isRegularExpressionLiteral(pattern) &&
        NEGATED_IDENTIFIER_CLASS.test(pattern.text)
      ) {
        found.push(`${where(source, node)} ${pattern.text}`);
      }
    });
  }
  return found;
}

describe('plugins take "every instance" from the SDK and never repair an identifier', () => {
  it('the check reads an identifier repair, and not a printable-text filter', () => {
    expect(NEGATED_IDENTIFIER_CLASS.test('/[^a-zA-Z0-9_./~-]/g')).toBe(true);
    expect(NEGATED_IDENTIFIER_CLASS.test('/[^A-Za-z0-9]/g')).toBe(true);
    expect(NEGATED_IDENTIFIER_CLASS.test('/[^\\x20-\\x7e]/g')).toBe(false);
    expect(NEGATED_IDENTIFIER_CLASS.test('/[a-z0-9]/g')).toBe(false);
  });

  it.each(PLUGIN_FOLDERS)('%s declares no ANY_IDENT of its own', (folder) => {
    expect(localAnyIdents(folder)).toEqual([]);
  });

  it.each(PLUGIN_FOLDERS)('%s replaces no character an identifier may not hold', (folder) => {
    expect(identifierRepairs(folder)).toEqual([]);
  });
});
