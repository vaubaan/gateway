/**
 * Structural: a `catch` that ignores its error rethrows, logs, or says why it may
 * (docs/quality/code-quality.md, rule 3). A catch that drops its error and returns `null`,
 * `false` or `undefined` turns a failure into an empty result: nobody ever sees it.
 *
 * Read from the source with the TypeScript parser: every `catch` of `apps/gateway/src` (tests
 * aside) whose error is not bound, or bound to a `_`-prefixed name, must
 *
 *   - start its block with a `// expected: <why>` comment (the failure is the answer: user
 *     input that does not parse, a probe, a best-effort cleanup), or
 *   - contain a `throw`, or
 *   - contain a logger call (`logger.` or `log.` with `warn`, `error` or `info`).
 *
 * A catch that binds its error and uses it is not this test's business.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCANNED = 'apps/gateway/src';
const SKIPPED_FILE = /\.test\.tsx?$|\.d\.ts$/;
const SOURCE_FILE = /\.tsx?$/;

/**
 * Folders not yet under the rule: being edited by a parallel change on 2026-11-28; to be
 * brought under the rule next. Delete an entry (or the whole set) once its folder passes.
 */
const NOT_YET_UNDER_THE_RULE: ReadonlySet<string> = new Set([
  'apps/gateway/src/server/accounts/',
  'apps/gateway/src/server/auth/',
  'apps/gateway/src/server/execution/',
  'apps/gateway/src/server/git/',
]);

const EXPECTED_COMMENT = /^\/\/ expected: \S/;
const THROWS = /\bthrow\b/;
const LOGS = /\b(?:logger|log)\.(?:warn|error|info)\(/;

interface SilentCatch {
  readonly line: number;
  readonly text: string;
}

function ignoresItsError(clause: ts.CatchClause): boolean {
  const binding = clause.variableDeclaration?.name;
  if (binding === undefined) return true;
  return ts.isIdentifier(binding) && binding.text.startsWith('_');
}

/** Whether the block of a catch says why, rethrows, or logs. */
function accountsForIt(block: ts.Block, source: ts.SourceFile): boolean {
  const body = source.text.slice(block.getStart(source) + 1, block.end - 1);
  const first = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first !== undefined && EXPECTED_COMMENT.test(first)) return true;
  return THROWS.test(body) || LOGS.test(body);
}

/** The catches of `text` that ignore their error and do none of the three. */
function silentCatchesOf(text: string, fileName = 'file.tsx'): SilentCatch[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: SilentCatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && ignoresItsError(node) && !accountsForIt(node.block, source)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, text: node.getText(source).split('\n')[0] ?? '' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function countCatches(text: string, fileName: string): number {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && ignoresItsError(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(name) && !SKIPPED_FILE.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(join(REPO, SCANNED))
  .map((path) => relative(REPO, path))
  .filter((file) => ![...NOT_YET_UNDER_THE_RULE].some((folder) => file.startsWith(folder)));

describe('no silent catch (code-quality rule 3)', () => {
  it('tells a silent catch from one that says why, rethrows or logs', () => {
    const silent = silentCatchesOf(
      [
        'try { a(); } catch { return null; }',
        'try { a(); } catch (_err) { return false; }',
        'try { a(); } catch {\n  // the next poll tries again\n}',
      ].join('\n'),
    );
    expect(silent.map((c) => c.line)).toEqual([1, 2, 3]);
    const accounted = silentCatchesOf(
      [
        'try { a(); } catch {\n  // expected: user input that does not parse\n  return null;\n}',
        'try { a(); } catch { throw new Refusal(); }',
        "try { a(); } catch { deps.logger.warn('lost'); }",
        'try { a(); } catch (err) { return null; }',
      ].join('\n'),
    );
    expect(accounted).toEqual([]);
  });

  it('scans the gateway source and finds catches that ignore their error', () => {
    expect(FILES.length).toBeGreaterThan(100);
    const total = FILES.reduce(
      (sum, file) => sum + countCatches(readFileSync(join(REPO, file), 'utf8'), file),
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it('every catch that ignores its error carries an expected comment, rethrows, or logs', () => {
    const silent = FILES.flatMap((file) =>
      silentCatchesOf(readFileSync(join(REPO, file), 'utf8'), file).map(
        (c) => `${file}:${c.line} ${c.text}`,
      ),
    );
    expect(
      silent,
      'add `// expected: <why>` as the first line of the block, rethrow, or log it',
    ).toEqual([]);
  });

  it('every folder not yet under the rule still exists', () => {
    for (const folder of NOT_YET_UNDER_THE_RULE) {
      expect(statSync(join(REPO, folder)).isDirectory(), folder).toBe(true);
    }
  });
});
