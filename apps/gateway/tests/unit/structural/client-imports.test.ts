/**
 * Structural: what the browser runs never pulls a server module (packages audit
 * 2026-10-31, F6). The rules a form shows before it posts — the mission preview,
 * the catalog views, the macro-actions, the share restriction, the reference's
 * links — are pure and live under `src/lib/`; `src/server/` holds what touches the
 * store, the root or the network. So a `'use client'` file imports values from
 * `@/lib/`, `@/components/` and the packages' browser-safe subpaths, and from
 * `@/server/` types only (erased at build). And the pure rules under `src/lib/`
 * (`authority`, `missions`, `providers`, `shares`) import no value from
 * `src/server/`: one careless import there would carry the store into the bundle.
 * (`lib/auth`, `lib/accounts`, `lib/instance.ts` are server-side page helpers.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The value imports of a file (a type-only import or specifier is erased). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    const bindings = clause?.namedBindings;
    const onlyTypes =
      clause !== undefined &&
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly);
    if (!onlyTypes) specs.push(statement.moduleSpecifier.text);
  }
  return specs;
}

function isClient(file: string): boolean {
  return /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8'));
}

const FILES = sources(SRC);

describe('the browser bundle', () => {
  it('finds client components to check', () => {
    expect(FILES.filter(isClient).length).toBeGreaterThan(20);
  });

  it('a client component imports no value from src/server', () => {
    const offending = FILES.filter(isClient).flatMap((file) =>
      valueImports(file)
        .filter((spec) => spec.startsWith('@/server/'))
        .map((spec) => `${relative(SRC, file)} → ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('the pure rules of src/lib import no value from src/server', () => {
    const pure = ['authority', 'missions', 'providers', 'shares'].map((dir) =>
      join(SRC, 'lib', dir),
    );
    const offending = FILES.filter((file) => pure.some((dir) => file.startsWith(dir))).flatMap(
      (file) =>
        valueImports(file)
          .filter((spec) => {
            if (spec.startsWith('@/server/')) return true;
            if (!spec.startsWith('.')) return false;
            return resolve(dirname(file), spec).startsWith(join(SRC, 'server'));
          })
          .map((spec) => `${relative(SRC, file)} → ${spec}`),
    );
    expect(offending).toEqual([]);
  });
});
