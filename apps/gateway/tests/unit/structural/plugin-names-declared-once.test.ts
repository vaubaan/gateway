/**
 * Structural test (`plugins/README.md`, step 1 and step 4): a plugin writes
 * its provider id and its tool names once, in `src/identity.ts`, and its tool
 * declarations in `src/tools.ts`; every other file imports `PROVIDER_ID` and
 * `TOOL`. A tool renamed in one place is then a compile error everywhere
 * else, never a classifier branch that silently stops matching.
 *
 * Read with the TypeScript parser over every source file of every plugin
 * folder but those two (the YAML is not TypeScript): a string literal, a
 * template literal's text or an object key that starts with the plugin's
 * tool prefix (`github__`), or a string literal equal to its provider id
 * (`'github'`), is refused, with its file and line. A literal equal to an id
 * that names something else (ssh's remote command `ssh`) is listed below
 * with its reason.
 */
import { toolPrefixFor } from '@vaubaan/plugin-sdk';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  eachNode,
  parsed,
  PLUGIN_FOLDERS,
  providerIdOf,
  REPO,
  sourceFilesOf,
  where,
} from './plugin-sources';

/** The two files where the names are written. */
const DECLARING_FILES = new Set(['identity.ts', 'tools.ts']);

/**
 * Literals equal to a provider id that name something else, each with the
 * reason. Keyed by `plugins/<folder>/src/<file>` and the literal; the line
 * may move.
 */
const OTHER_MEANINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'plugins/ssh/src/command/opaque.ts': {
    ssh: 'the remote command `ssh` on the agent’s command line, which reaches another host',
  },
};

/** `file:line 'text'` of every name of the plugin written outside the declaring files. */
function namesWrittenOutside(folder: string): string[] {
  const id = providerIdOf(folder);
  const prefix = toolPrefixFor(id);
  const found: string[] = [];
  for (const path of sourceFilesOf(folder)) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    if (DECLARING_FILES.has(file)) continue;
    const source = parsed(path);
    eachNode(source, (node) => {
      const text = writtenName(node);
      if (text === null) return;
      if (text.startsWith(prefix) || (text === id && ts.isStringLiteralLike(node))) {
        const file = source.fileName.slice(REPO.length + 1);
        if (!text.startsWith(prefix) && OTHER_MEANINGS[file]?.[text]) return;
        found.push(`${where(source, node)} '${text}'`);
      }
    });
  }
  return found;
}

/**
 * The text a node writes as it is: a string literal, the text of a template
 * literal before its first substitution, or an object key spelled as an
 * identifier (`{ github__get_issue: … }`).
 */
function writtenName(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateHead(node)) return node.text;
  if (ts.isIdentifier(node) && node.parent && ts.isPropertyAssignment(node.parent)) {
    return node.parent.name === node ? node.text : null;
  }
  return null;
}

describe('a plugin declares its provider id and its tool names once', () => {
  it('finds the plugin folders, the template among them', () => {
    expect(PLUGIN_FOLDERS).toContain('_template');
    expect(PLUGIN_FOLDERS.length).toBeGreaterThan(1);
  });

  it('every literal of another meaning is still in its file', () => {
    for (const [file, literals] of Object.entries(OTHER_MEANINGS)) {
      const source = parsed(`${REPO}/${file}`);
      const written = new Set<string>();
      eachNode(source, (node) => {
        if (ts.isStringLiteralLike(node)) written.add(node.text);
      });
      expect(
        Object.keys(literals).filter((text) => !written.has(text)),
        file,
      ).toEqual([]);
    }
  });

  it.each(PLUGIN_FOLDERS)(
    '%s writes no tool name and no provider id outside identity.ts and tools.ts',
    (folder) => {
      expect(namesWrittenOutside(folder)).toEqual([]);
    },
  );
});
