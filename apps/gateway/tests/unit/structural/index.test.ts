/**
 * The index of the structural suite (see `manifest.ts`): every invariant has
 * a proof that still exists, every structural test is reachable from the
 * index, and every bullet of the spec's "Structural" list is held here.
 *
 * "Still exists" is read with the TypeScript parser, not by searching the text:
 * a proof is a test the runner will run. A title that survives only in a comment,
 * on an `it.skip` / `it.todo`, or under a `describe.skipIf` the index does not
 * mention, fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { INVARIANTS } from './manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const FOLDER = 'apps/gateway/tests/unit/structural';
const SPEC = 'docs/spec/vaubaan-gateway.md';

/** One line: bullets of the spec wrap, titles in a test file do not. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A test or a suite a proof file declares, as the runner will treat it. */
interface DeclaredTest {
  /** The title, flattened to one line (a template title keeps its text parts). */
  readonly title: string;
  /** `.skip`, `.todo` on it or on a suite around it: it never runs. */
  readonly skipped: boolean;
  /** `.skipIf(…)` / `.runIf(…)` on it or on a suite around it: it runs on a condition. */
  readonly conditional: boolean;
}

const RUNNER_ROOTS = new Set(['it', 'test', 'describe', 'suite']);
const NEVER_RUNS = new Set(['skip', 'todo']);
const RUNS_ON_CONDITION = new Set(['skipIf', 'runIf']);

/** `it` / `it.each(table)` / `describe.skipIf(cond)` → the root name and the modifiers. */
function runnerCallee(node: ts.Expression): { root: string; modifiers: string[] } | null {
  const modifiers: string[] = [];
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isCallExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current)) {
      modifiers.push(current.name.text);
      current = current.expression;
    } else break;
  }
  return ts.isIdentifier(current) && RUNNER_ROOTS.has(current.text)
    ? { root: current.text, modifiers }
    : null;
}

function titleOf(argument: ts.Expression | undefined): string | null {
  if (!argument) return null;
  if (ts.isStringLiteralLike(argument)) return flat(argument.text);
  if (ts.isTemplateExpression(argument)) {
    return flat(
      argument.head.text + argument.templateSpans.map((span) => `…${span.literal.text}`).join(''),
    );
  }
  return null;
}

/**
 * Every test and suite of a TypeScript or JavaScript test file, read with the
 * compiler's parser: a title in a comment, in a string that is not a title, or on
 * a skipped test is not a declared test.
 */
function declaredTests(path: string): DeclaredTest[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: DeclaredTest[] = [];
  const visit = (node: ts.Node, skipped: boolean, conditional: boolean): void => {
    let inner = { skipped, conditional };
    if (ts.isCallExpression(node)) {
      const callee = runnerCallee(node.expression);
      const title = callee ? titleOf(node.arguments[0]) : null;
      if (callee && title !== null) {
        inner = {
          skipped: skipped || callee.modifiers.some((m) => NEVER_RUNS.has(m)),
          conditional: conditional || callee.modifiers.some((m) => RUNS_ON_CONDITION.has(m)),
        };
        found.push({ title, ...inner });
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner.skipped, inner.conditional));
  };
  visit(source, false, false);
  return found;
}

/** The bullets under "- **Structural**:" of spec §10, each flattened to one line. */
function specStructuralBullets(): string[] {
  const spec = readFileSync(resolve(REPO, SPEC), 'utf8');
  const start = spec.indexOf('- **Structural**:');
  if (start < 0) throw new Error(`${SPEC} has no "- **Structural**:" list`);
  const rest = spec.slice(start).split('\n').slice(1);
  const bullets: string[] = [];
  for (const line of rest) {
    if (/^ {2}- /.test(line)) bullets.push(line.trim().slice(2));
    else if (/^ {4}\S/.test(line) && bullets.length > 0) {
      bullets[bullets.length - 1] = `${bullets.at(-1) ?? ''} ${line.trim()}`;
    } else break;
  }
  return bullets.map(flat);
}

describe('the structural suite is indexed', () => {
  it('lists invariants, each once, each stated and sourced', () => {
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(20);
    const ids = INVARIANTS.map((invariant) => invariant.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const invariant of INVARIANTS) {
      expect(invariant.id, invariant.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(invariant.statement.length, invariant.id).toBeGreaterThan(40);
      expect(invariant.source.length, invariant.id).toBeGreaterThan(5);
    }
  });

  describe.each(INVARIANTS.map((invariant) => [invariant.id, invariant] as const))(
    '%s',
    (_id, invariant) => {
      it('has at least one proof', () => {
        expect(invariant.proofs.length).toBeGreaterThan(0);
        for (const proof of invariant.proofs) expect(proof.tests.length).toBeGreaterThan(0);
      });

      it.each(invariant.proofs.map((proof) => [proof.file, proof] as const))(
        'its proof %s exists and still holds the tests named',
        (file, proof) => {
          const path = resolve(REPO, file);
          expect(existsSync(path), `${file} is missing`).toBe(true);
          if (!/\.test\.(?:ts|tsx|mjs)$/.test(file)) {
            // A shell proof (the image smoke test): the step is named by its message.
            const source = flat(readFileSync(path, 'utf8'));
            const gone = proof.tests.filter((title) => !source.includes(flat(title)));
            expect(gone, `${file} no longer holds these steps`).toEqual([]);
            return;
          }
          const declared = declaredTests(path);
          const holding = (title: string): DeclaredTest[] =>
            declared.filter((test) => test.title.includes(flat(title)));
          const gone = proof.tests.filter((title) => holding(title).length === 0);
          expect(gone, `${file} declares no test with these titles`).toEqual([]);
          // A title that only skipped or to-do tests carry proves nothing.
          const dead = proof.tests.filter((title) => holding(title).every((test) => test.skipped));
          expect(dead, `${file} only skips these tests`).toEqual([]);
          // A proof that runs on a condition says which, and one that says so is one.
          const conditional = proof.tests.filter((title) =>
            holding(title).every((test) => test.skipped || test.conditional),
          );
          if (proof.conditional === undefined) {
            expect(
              conditional,
              `${file}: these tests run on a condition the index does not state`,
            ).toEqual([]);
          } else {
            expect(proof.conditional.length).toBeGreaterThan(20);
            expect(
              conditional.length,
              `${file}: stated conditional, but no named test is`,
            ).toBeGreaterThan(0);
          }
        },
      );
    },
  );

  it('every test file of this folder proves an invariant of the index', () => {
    const indexed = new Set(
      INVARIANTS.flatMap((invariant) => invariant.proofs.map((proof) => proof.file)),
    );
    const here = readdirSync(HERE)
      .filter((name) => /\.test\.tsx?$/.test(name) && name !== 'index.test.ts')
      .map((name) => join(FOLDER, name));
    expect(here.length).toBeGreaterThan(8);
    expect(here.filter((file) => !indexed.has(file))).toEqual([]);
  });

  it('holds every bullet of the spec’s "Structural" list', () => {
    const bullets = specStructuralBullets();
    expect(bullets.length).toBeGreaterThanOrEqual(6);
    const claimed = INVARIANTS.flatMap((invariant) =>
      invariant.specBullet ? [flat(invariant.specBullet)] : [],
    );
    const unheld = bullets.filter((bullet) => !claimed.some((part) => bullet.includes(part)));
    expect(unheld, 'spec §10 bullets with no invariant in manifest.ts').toEqual([]);
    // And no invariant claims a bullet the spec does not have (a stale quote).
    const stale = claimed.filter((part) => !bullets.some((bullet) => bullet.includes(part)));
    expect(stale, 'manifest quotes that are not in spec §10 any more').toEqual([]);
  });

  describe('the threat-model handbook cites proofs that exist', () => {
    const HANDBOOK = 'docs/handbook/threat-model.md';
    const handbook = readFileSync(resolve(REPO, HANDBOOK), 'utf8');

    it('every [inv: id] it cites is an invariant of the index', () => {
      const cited = [...handbook.matchAll(/\[inv: ([a-z0-9-]+)\]/g)].map((match) => match[1]);
      expect(cited.length).toBeGreaterThan(15);
      const known = new Set(INVARIANTS.map((invariant) => invariant.id));
      expect([...new Set(cited)].filter((id) => id !== undefined && !known.has(id))).toEqual([]);
    });

    it('every test file it names exists', () => {
      // `tests/…` is under apps/gateway, `src/…` under apps/gateway/src/server; other
      // paths (packages/, plugins/, deploy/, scripts/) are from the repository root.
      const named = [
        ...handbook.matchAll(
          /`((?:tests|src|packages|plugins|apps|scripts|deploy)\/[^`\s]*\.(?:test\.(?:ts|tsx|mjs)|sh))`/g,
        ),
      ].map((match) => match[1] ?? '');
      expect(named.length).toBeGreaterThan(25);
      const pathOf = (cited: string): string =>
        cited.startsWith('tests/')
          ? `apps/gateway/${cited}`
          : cited.startsWith('src/')
            ? `apps/gateway/src/server/${cited.slice('src/'.length)}`
            : cited;
      const missing = [...new Set(named)].filter(
        (cited) => !existsSync(resolve(REPO, pathOf(cited))),
      );
      expect(missing).toEqual([]);
    });

    it('numbers its accepted risks once each, in order', () => {
      const numbers = [...handbook.matchAll(/^\| A(\d+) /gm)].map((match) => Number(match[1]));
      expect(numbers.length).toBeGreaterThan(10);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    });
  });

  it('a proof file is never a file that cannot fail: each one is run by a test runner or by CI', () => {
    const RUN_BY = /\.test\.(?:ts|tsx|mjs)$|^deploy\/docker\/smoke\.sh$/;
    const files = INVARIANTS.flatMap((invariant) => invariant.proofs.map((proof) => proof.file));
    expect(files.filter((file) => !RUN_BY.test(file))).toEqual([]);
  });
});
