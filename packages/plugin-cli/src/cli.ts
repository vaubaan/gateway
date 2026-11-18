#!/usr/bin/env node
/**
 * `vaubaan-plugin` — the plugin author's command line (spec plugin-authoring §1).
 *
 *   vaubaan-plugin build [<plugin dir>] [--out <dir>]   the archive: <out>/ and <out>.tgz
 *   vaubaan-plugin keygen [--out <name>]                 a company key: <name>.key.pem, <name>.pub.pem
 *   vaubaan-plugin sign <archive dir> --key <file>       vaubaan-manifest.json.sig.json, then <dir>.tgz again
 *   vaubaan-plugin pack <archive dir> [--out <file>]     <dir>.tgz from the folder, signatures included
 *
 * `build` writes the default `dist/plugin` inside the plugin's folder. A signature lands
 * beside the manifest and is packed with it: what an administrator uploads is the `.tgz`.
 * Exit 1 when a step is refused; 2 on a usage error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_MANIFEST_FILE,
  generateSigningKey,
  packArchive,
  readArchive,
  SIGNATURE_FILE,
  signManifest,
} from '@vaubaan/plugin-sdk/archive';

import { ArchiveError, buildArchive, filesOf } from './archive.ts';

export const USAGE = [
  'usage: vaubaan-plugin build [<plugin dir>] [--out <dir>]',
  '       vaubaan-plugin keygen [--out <name>]',
  '       vaubaan-plugin sign <archive dir> --key <private key file>',
  '       vaubaan-plugin pack <archive dir> [--out <file>]',
].join('\n');

export type Command =
  | { readonly name: 'build'; readonly pluginDir: string; readonly out: string }
  | { readonly name: 'keygen'; readonly out: string }
  | { readonly name: 'sign'; readonly dir: string; readonly key: string }
  | { readonly name: 'pack'; readonly dir: string; readonly out: string };

class UsageError extends Error {}

/** `[positionals, options]` of the arguments after the command name; every option takes a value. */
function split(
  rest: readonly string[],
  allowed: readonly string[],
): { positionals: string[]; options: Map<string, string> } {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument.startsWith('--')) {
      if (!allowed.includes(argument)) throw new UsageError(`unknown option ${argument}\n${USAGE}`);
      const value = rest[index + 1];
      index += 1;
      if (value === undefined || value === '') {
        throw new UsageError(`${argument} needs a value\n${USAGE}`);
      }
      options.set(argument, value);
    } else positionals.push(argument);
  }
  return { positionals, options };
}

/** Parses the command line, relative to `cwd`. Pure. */
export function parseCommand(argv: readonly string[], cwd: string): Command {
  const [name, ...rest] = argv;
  switch (name) {
    case 'build': {
      const { positionals, options } = split(rest, ['--out']);
      if (positionals.length > 1) throw new UsageError(USAGE);
      const dir = resolve(cwd, positionals[0] ?? '.');
      const out = options.get('--out');
      return { name, pluginDir: dir, out: resolve(cwd, out ?? join(dir, 'dist', 'plugin')) };
    }
    case 'keygen': {
      const { positionals, options } = split(rest, ['--out']);
      if (positionals.length > 0) throw new UsageError(USAGE);
      return { name, out: resolve(cwd, options.get('--out') ?? 'vaubaan-plugin-signing') };
    }
    case 'sign': {
      const { positionals, options } = split(rest, ['--key']);
      const key = options.get('--key');
      if (positionals.length !== 1 || key === undefined) throw new UsageError(USAGE);
      return { name, dir: resolve(cwd, positionals[0] as string), key: resolve(cwd, key) };
    }
    case 'pack': {
      const { positionals, options } = split(rest, ['--out']);
      if (positionals.length !== 1) throw new UsageError(USAGE);
      const dir = resolve(cwd, positionals[0] as string);
      return { name, dir, out: resolve(cwd, options.get('--out') ?? `${dir}.tgz`) };
    }
    default:
      throw new UsageError(USAGE);
  }
}

/** Packs a folder into its archive and checks the result reads back. */
function pack(dir: string, out: string): string {
  const bytes = packArchive(filesOf(dir));
  const read = readArchive(bytes);
  writeFileSync(out, bytes);
  return `${read.manifest.id} ${read.manifest.version} → ${out}`;
}

async function execute(command: Command, io: { log: (line: string) => void }): Promise<number> {
  switch (command.name) {
    case 'build': {
      const result = await buildArchive({ pluginDir: command.pluginDir, outDir: command.out });
      if ('skipped' in result) {
        throw new ArchiveError(
          `not built: the plugin declares itself not bundleable (${result.skipped})`,
        );
      }
      io.log(`built ${result.id} ${result.version} → ${result.archive}`);
      return 0;
    }
    case 'keygen': {
      const privatePath = `${command.out}.key.pem`;
      const publicPath = `${command.out}.pub.pem`;
      if (existsSync(privatePath) || existsSync(publicPath)) {
        throw new ArchiveError(`${privatePath} or ${publicPath} exists: nothing was overwritten`);
      }
      const key = generateSigningKey();
      writeFileSync(privatePath, key.privateKeyPem, { mode: 0o600 });
      writeFileSync(publicPath, key.publicKeyPem);
      io.log(`private key → ${privatePath} (keep it in your CI's secrets, never in a repository)`);
      io.log(`public key  → ${publicPath} (add it once as a trusted signer of your gateway)`);
      io.log(`key id      ${key.keyId}`);
      return 0;
    }
    case 'sign': {
      const manifest = readFileSync(join(command.dir, ARCHIVE_MANIFEST_FILE));
      const signature = signManifest(manifest, readFileSync(command.key, 'utf8'));
      writeFileSync(join(command.dir, SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`);
      io.log(`signed with ${signature.keyId}`);
      io.log(`packed ${pack(command.dir, `${command.dir}.tgz`)}`);
      return 0;
    }
    case 'pack':
      io.log(`packed ${pack(command.dir, command.out)}`);
      return 0;
  }
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
    return await execute(command, io);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
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
