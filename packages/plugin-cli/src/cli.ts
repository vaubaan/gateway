#!/usr/bin/env node
/**
 * `vaubaan-plugin` — the plugin author's command line (spec plugin-authoring §1).
 *
 *   vaubaan-plugin build [<plugin dir>] [--out <dir>]
 *
 * Builds the plugin's archive (default: `dist/plugin` inside the plugin's folder) and
 * prints its id, version and path. Exit 1 when the build is refused; 2 on a usage error.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArchiveError, buildArchive } from './archive.ts';

export const USAGE = 'usage: vaubaan-plugin build [<plugin dir>] [--out <dir>]';

export interface Command {
  readonly name: 'build';
  readonly pluginDir: string;
  readonly out: string;
}

class UsageError extends Error {}

/** Parses the command line, relative to `cwd`. Pure. */
export function parseCommand(argv: readonly string[], cwd: string): Command {
  const [name, ...rest] = argv;
  if (name !== 'build') throw new UsageError(USAGE);
  let pluginDir: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument === '--out') {
      out = rest[index + 1];
      index += 1;
      if (out === undefined || out === '')
        throw new UsageError(`--out needs a directory\n${USAGE}`);
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${argument}\n${USAGE}`);
    } else if (pluginDir === undefined) {
      pluginDir = argument;
    } else {
      throw new UsageError(USAGE);
    }
  }
  const dir = resolve(cwd, pluginDir ?? '.');
  return { name, pluginDir: dir, out: resolve(cwd, out ?? join(dir, 'dist', 'plugin')) };
}

/** Runs a command; returns the exit code. */
export async function run(
  argv: readonly string[],
  io: {
    readonly cwd: string;
    readonly log: (line: string) => void;
    readonly error: (line: string) => void;
  },
): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv, io.cwd);
  } catch (err) {
    io.error(err instanceof UsageError ? err.message : String(err));
    return 2;
  }
  try {
    const result = await buildArchive({ pluginDir: command.pluginDir, outDir: command.out });
    if ('skipped' in result) {
      io.error(`not built: the plugin declares itself not bundleable (${result.skipped})`);
      return 1;
    }
    io.log(`built ${result.id} ${result.version} → ${result.archive}`);
    return 0;
  } catch (err) {
    io.error(err instanceof ArchiveError ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
    error: (line) => console.error(line),
  });
}
