/**
 * Structural test (ADR plugin-identifiers-one-grammar-for-classify-and-execute):
 * every plugin under `plugins/` — shipped, or the template a contributor
 * copies — has a test file that feeds hostile identifiers to **both** its
 * classifier and its executor.
 *
 * "What is executed is what was classified" is a property of each plugin and
 * is proven in each plugin's own tests. This file only holds that no plugin
 * is without that proof: a plugin added tomorrow fails here until it has one.
 * The directory is read, not listed; and every plugin the image ships must be
 * one of the directories found.
 *
 * What counts as such a test file is read with the TypeScript parser, not
 * matched as text: the hostile values are string literals of the code, the
 * classifier and the executor are **called** (an import, a comment or the word
 * "executed" in a title is not a call), and at least one test of the file runs
 * (not `skip`, not `todo`). It remains a statement about the shape of the
 * file: that the calls are handed the hostile values is what the plugin's own
 * assertions say, read one by one in `manifest.ts`.
 *
 * The behaviour itself is proven by the SDK kit: `assertIdentifiersRefused`
 * runs the plugin's own `classify` and `execute` on every string argument of
 * its samples, with the hostile values, and holds that a refused value sends
 * nothing and an accepted one is named exactly (`packages/plugin-sdk`,
 * `testing/identifiers.ts`). Here, every plugin must call it in a test that
 * runs: a plugin added tomorrow cannot leave it out.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PLUGINS = join(REPO, 'plugins');

/** The dot segment, and at least one encoded or separator form: the values the defect lived on. */
const DOT_SEGMENT = /^\.\.$/;
const OTHER_HOSTILE = /%2e%2e|%2f|\.\.\/|\/\.\./i;
const RUNNERS = new Set(['it', 'test']);
/** The SDK kit's behavioural proof (`@vaubaan/plugin-sdk/testing`). */
const IDENTIFIER_PROOF = 'assertIdentifiersRefused';
const NEVER_RUNS = new Set(['skip', 'todo']);

interface FileShape {
  /** String literals of the code (comments are not part of the tree). */
  readonly literals: string[];
  /** Names of what is called: `classifyX(…)`, `plugin.execute(…)`. */
  readonly called: Set<string>;
  /** Tests that run: `it(…)`, `it.each(…)(…)`, not `it.skip` nor `it.todo`. */
  readonly runningTests: number;
}

function shapeOf(code: string, path = 'plugin.test.ts'): FileShape {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.ES2022, true);
  const literals: string[] = [];
  const called = new Set<string>();
  let runningTests = 0;
  /** `it`, `it.each`, `it.skip`, `it.each(table)`: the runner and what was chained on it. */
  const runnerOf = (node: ts.Expression): { root: string; chain: string[] } | null => {
    if (ts.isIdentifier(node)) return { root: node.text, chain: [] };
    if (ts.isPropertyAccessExpression(node)) {
      const inner = runnerOf(node.expression);
      return inner && { root: inner.root, chain: [...inner.chain, node.name.text] };
    }
    if (ts.isCallExpression(node)) return runnerOf(node.expression);
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    if (ts.isTemplateExpression(node)) literals.push(node.getText(source));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) called.add(callee.text);
      if (ts.isPropertyAccessExpression(callee)) called.add(callee.name.text);
      const runner = runnerOf(callee);
      const hasBody = node.arguments.some(
        (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      );
      if (
        runner &&
        RUNNERS.has(runner.root) &&
        hasBody &&
        !runner.chain.some((name) => NEVER_RUNS.has(name))
      ) {
        runningTests += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { literals, called, runningTests };
}

/** True when the file feeds hostile identifiers to a classifier and to an executor. */
function provesBothSides(shape: FileShape): boolean {
  const calls = [...shape.called];
  return (
    shape.runningTests > 0 &&
    shape.literals.some((literal) => DOT_SEGMENT.test(literal)) &&
    shape.literals.some((literal) => OTHER_HOSTILE.test(literal)) &&
    calls.some((name) => /classify/i.test(name)) &&
    calls.some((name) => /^execut/i.test(name))
  );
}

const pluginDirs = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort();

/** The unit test files of a plugin where a running test calls the SDK's identifier proof. */
function kitProofsOf(plugin: string): string[] {
  const dir = join(PLUGINS, plugin, 'tests/unit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.test\.ts$/.test(name))
    .filter((name) => {
      const shape = shapeOf(readFileSync(join(dir, name), 'utf8'), name);
      return shape.runningTests > 0 && shape.called.has(IDENTIFIER_PROOF);
    });
}

/** The unit test files of a plugin that exercise hostile identifiers on both sides. */
function identifierTestsOf(plugin: string): string[] {
  const dir = join(PLUGINS, plugin, 'tests/unit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.test\.ts$/.test(name))
    .filter((name) => provesBothSides(shapeOf(readFileSync(join(dir, name), 'utf8'), name)));
}

describe('every plugin proves that what it executes is what it classified', () => {
  it('finds the plugins, the template among them, and every shipped one', () => {
    expect(pluginDirs).toContain('_template');
    expect(pluginDirs.length).toBeGreaterThanOrEqual(REPOSITORY_PLUGINS.length + 1);
    const manifests = new Set(
      pluginDirs.map(
        (dir) =>
          (
            JSON.parse(readFileSync(join(PLUGINS, dir, 'package.json'), 'utf8')) as {
              name?: string;
            }
          ).name,
      ),
    );
    // Each shipped plugin is one of these directories: none is tested by omission.
    for (const plugin of REPOSITORY_PLUGINS) {
      expect(
        manifests.has(`@vaubaan/plugin-${plugin.id}`),
        `no directory under plugins/ is the package of '${plugin.id}'`,
      ).toBe(true);
    }
  });

  it('does not take an import, a comment or a skipped test for a proof', () => {
    const real = `
      import { classifyWidget, executeWidget } from '../src';
      it.each(['..', '%2e%2e', 'a/../b'])('refuses %s', async (id) => {
        expect(classifyWidget('get', { id })).toMatchObject({ deny: expect.any(String) });
        expect((await executeWidget(ctx, 'get', { id })).isError).toBe(true);
      });`;
    expect(provesBothSides(shapeOf(real))).toBe(true);

    // The words are there; nothing is called.
    const wordsOnly = `
      import { classifyWidget, executeWidget } from '../src';
      // feeds '..' and '%2e%2e' to classify and to execute
      const table = ['..', '../x'];
      it('is executed as classified', () => { expect(table).toHaveLength(2); });`;
    expect(provesBothSides(shapeOf(wordsOnly))).toBe(false);

    // Called, in a test that never runs.
    expect(provesBothSides(shapeOf(real.replace('it.each', 'it.skip.each')))).toBe(false);
    expect(
      provesBothSides(
        shapeOf(`it.todo('refuses ..'); const x = ['..', '../x']; classify(x); execute(x);`),
      ),
    ).toBe(false);
    // One side only.
    expect(provesBothSides(shapeOf(real.replace(/executeWidget\(ctx/, 'runWidget(ctx')))).toBe(
      false,
    );
  });

  it.each(pluginDirs)(
    '%s has a test feeding hostile identifiers to classify and to execute',
    (plugin) => {
      expect(identifierTestsOf(plugin)).not.toEqual([]);
    },
  );

  it.each(pluginDirs)('%s runs the identifier proof of the SDK kit', (plugin) => {
    expect(kitProofsOf(plugin)).not.toEqual([]);
  });

  it('does not take an import of the kit, or a skipped test, for a run of it', () => {
    const calls = (code: string) => {
      const shape = shapeOf(code);
      return shape.runningTests > 0 && shape.called.has(IDENTIFIER_PROOF);
    };
    const real = `
      import { assertIdentifiersRefused } from '@vaubaan/plugin-sdk/testing';
      test('hostile identifiers', async () => { await assertIdentifiersRefused(plugin, SAMPLES, { context }); });`;
    expect(calls(real)).toBe(true);
    expect(calls(real.replace('await assertIdentifiersRefused(', 'await somethingElse('))).toBe(
      false,
    );
    expect(calls(real.replace("test('", "test.skip('"))).toBe(false);
  });
});
