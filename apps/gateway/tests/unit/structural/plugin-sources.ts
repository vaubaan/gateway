/**
 * The source of every plugin folder, read with the TypeScript parser: what
 * the structural tests that hold a plugin's code to the guide
 * (`plugins/README.md`) enumerate. Every folder of `plugins/` with a `src/`
 * is read, the template included: a convention the template breaks is one
 * every copy of it breaks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '@vaubaan/plugin-sdk';
import ts from 'typescript';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const PLUGINS = join(REPO, 'plugins');

/** The plugin folders: every folder of `plugins/` with a `src/`. */
export const PLUGIN_FOLDERS: readonly string[] = readdirSync(PLUGINS).filter((name) => {
  try {
    return statSync(join(PLUGINS, name, 'src')).isDirectory();
  } catch {
    return false;
  }
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Every TypeScript file of `plugins/<folder>/src`, as absolute paths. */
export function sourceFilesOf(folder: string): string[] {
  return filesUnder(join(PLUGINS, folder, 'src'));
}

/** One file, parsed (parents set, so a node knows where it sits). */
export function parsed(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** `plugins/<folder>/src/<file>:<line>` of a node. */
export function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName.slice(REPO.length + 1)}:${line + 1}`;
}

/** Every node of a file, depth first. */
export function eachNode(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

/** The `package.json` of a plugin folder, read as untyped JSON. */
export function packageJsonOf(folder: string): Readonly<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(readFileSync(join(PLUGINS, folder, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new Error(`plugins/${folder}/package.json is not an object`);
  return manifest;
}

/** The provider id a plugin folder holds: its package is `@vaubaan/plugin-<id>`. */
export function providerIdOf(folder: string): string {
  const name = packageJsonOf(folder).name;
  const prefix = '@vaubaan/plugin-';
  if (typeof name !== 'string' || !name.startsWith(prefix)) {
    throw new Error(`plugins/${folder}/package.json: name is not '${prefix}<id>'`);
  }
  return name.slice(prefix.length);
}
