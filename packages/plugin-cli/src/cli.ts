#!/usr/bin/env node
/**
 * `vaubaan-plugin` — the plugin author's command line (spec plugin-authoring §1).
 *
 *   vaubaan-plugin init <dir> --id <id> [--name <name>]  a new plugin project (init.ts)
 *   vaubaan-plugin try <tool> [<json args>] [--resources ref[:env],…] [--accept <risk>,…]
 *                      [--trust careful|trusting|autonomous]
 *                                                       one call, decided without a gateway (try.ts)
 *   vaubaan-plugin build [<plugin dir>] [--out <dir>]   the archive: <out>/ and <out>.tgz
 *   vaubaan-plugin submit [--owners a,b] [--dry-run]    the catalog's declaration of HEAD, as a
 *                                                       pull request on vaubaan/gateway-plugins (submit.ts)
 *   vaubaan-plugin deploy [<archive>] --gateway <url>    hands the archive to a gateway, pending
 *                                                       (deploy.ts; token in VAUBAAN_MISSION_TOKEN)
 *   vaubaan-plugin keygen [--out <name>]                 a company key: <name>.key.pem, <name>.pub.pem
 *   vaubaan-plugin sign <archive dir> --key <file>       vaubaan-manifest.json.sig.json, then <dir>.tgz again
 *   vaubaan-plugin pack <archive dir> [--out <file>]     <dir>.tgz from the folder, signatures included
 *
 * `build` writes the default `dist/plugin` inside the plugin's folder. A signature lands
 * beside the manifest and is packed with it: what an administrator uploads is the `.tgz`.
 * Exit 1 when a step is refused (for `try`: the call is not allowed); 2 on a usage error.
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
import { deployArchive, MISSION_TOKEN_ENV } from './deploy.ts';
import { initProject } from './init.ts';
import {
  declarationOf,
  declarationText,
  openSubmission,
  runCommand,
  type Runner,
} from './submit.ts';
import { TRUST_LEVELS, tryProjectCall, type TrustLevel } from './try.ts';

export const USAGE = [
  'usage: vaubaan-plugin init <dir> --id <id> [--name <display name>]',
  "       vaubaan-plugin try <tool> ['<json args>'] [--resources ref[:env],…] [--accept <risk id>,…] [--trust careful|trusting|autonomous]",
  '       vaubaan-plugin build [<plugin dir>] [--out <dir>]',
  '       vaubaan-plugin deploy [<archive .tgz>] --gateway <url>   (token in VAUBAAN_MISSION_TOKEN)',
  '       vaubaan-plugin submit [--owners <user or org/team>,…] [--dry-run]',
  '       vaubaan-plugin keygen [--out <name>]',
  '       vaubaan-plugin sign <archive dir> --key <private key file>',
  '       vaubaan-plugin pack <archive dir> [--out <file>]',
].join('\n');

export type Command =
  | {
      readonly name: 'init';
      readonly dir: string;
      readonly id: string;
      readonly displayName: string | undefined;
    }
  | {
      readonly name: 'try';
      readonly pluginDir: string;
      readonly tool: string;
      readonly args: string | undefined;
      readonly resources: string | undefined;
      readonly accept: string | undefined;
      readonly trust: TrustLevel | undefined;
    }
  | { readonly name: 'build'; readonly pluginDir: string; readonly out: string }
  | { readonly name: 'deploy'; readonly archive: string; readonly gateway: string }
  | {
      readonly name: 'submit';
      readonly pluginDir: string;
      readonly owners: readonly string[] | undefined;
      readonly dryRun: boolean;
    }
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
    case 'init': {
      const { positionals, options } = split(rest, ['--id', '--name']);
      const id = options.get('--id');
      if (positionals.length !== 1 || id === undefined) throw new UsageError(USAGE);
      return {
        name,
        dir: resolve(cwd, positionals[0] as string),
        id,
        displayName: options.get('--name'),
      };
    }
    case 'try': {
      const { positionals, options } = split(rest, ['--resources', '--accept', '--trust']);
      if (positionals.length < 1 || positionals.length > 2) throw new UsageError(USAGE);
      const trust = options.get('--trust');
      if (trust !== undefined && !(TRUST_LEVELS as readonly string[]).includes(trust)) {
        throw new UsageError(`--trust is one of ${TRUST_LEVELS.join(', ')}\n${USAGE}`);
      }
      return {
        name,
        pluginDir: cwd,
        tool: positionals[0] as string,
        args: positionals[1],
        resources: options.get('--resources'),
        accept: options.get('--accept'),
        trust: trust as TrustLevel | undefined,
      };
    }
    case 'build': {
      const { positionals, options } = split(rest, ['--out']);
      if (positionals.length > 1) throw new UsageError(USAGE);
      const dir = resolve(cwd, positionals[0] ?? '.');
      const out = options.get('--out');
      return { name, pluginDir: dir, out: resolve(cwd, out ?? join(dir, 'dist', 'plugin')) };
    }
    case 'submit': {
      const dryRun = rest.includes('--dry-run');
      const { positionals, options } = split(
        rest.filter((argument) => argument !== '--dry-run'),
        ['--owners'],
      );
      if (positionals.length > 0) throw new UsageError(USAGE);
      const owners = options.get('--owners');
      return {
        name,
        pluginDir: cwd,
        owners: owners
          ?.split(',')
          .map((owner) => owner.trim())
          .filter((owner) => owner !== ''),
        dryRun,
      };
    }
    case 'deploy': {
      const { positionals, options } = split(rest, ['--gateway']);
      const gateway = options.get('--gateway');
      if (positionals.length > 1 || gateway === undefined) throw new UsageError(USAGE);
      return {
        name,
        archive: resolve(cwd, positionals[0] ?? join('dist', 'plugin.tgz')),
        gateway,
      };
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

/** What a command reads of its surroundings; `env` and `fetch` are the process's unless given. */
export interface CliIo {
  readonly cwd: string;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** Runs git and gh for `submit`. */
  readonly run?: Runner;
}

async function execute(command: Command, io: CliIo): Promise<number> {
  switch (command.name) {
    case 'init': {
      const result = initProject({
        dir: command.dir,
        id: command.id,
        ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
      });
      io.log(`plugin ${result.id}: ${result.files} files → ${result.dir}`);
      io.log('next: npm install && npm run check, then open your coding agent there (AGENTS.md)');
      return 0;
    }
    case 'try': {
      const report = await tryProjectCall({
        pluginDir: command.pluginDir,
        tool: command.tool,
        ...(command.args === undefined ? {} : { args: command.args }),
        ...(command.resources === undefined ? {} : { resources: command.resources }),
        ...(command.accept === undefined ? {} : { accept: command.accept }),
        ...(command.trust === undefined ? {} : { trust: command.trust }),
      });
      for (const line of report.lines) io.log(line);
      return report.allowed ? 0 : 1;
    }
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
    case 'submit': {
      const run = io.run ?? runCommand;
      const declaration = declarationOf(command.pluginDir, {
        run,
        ...(command.owners === undefined ? {} : { owners: command.owners }),
      });
      io.log(`catalog/${declaration.id}.yaml`);
      for (const line of declarationText(declaration).trimEnd().split('\n')) io.log(`  ${line}`);
      if (command.dryRun) {
        io.log('dry run: nothing was sent');
        return 0;
      }
      io.log(`pull request: ${openSubmission(declaration, run)}`);
      io.log('the catalog rebuilds this commit without secrets; a maintainer reviews its report');
      return 0;
    }
    case 'deploy': {
      const result = await deployArchive({
        archive: command.archive,
        gateway: command.gateway,
        token: io.env?.[MISSION_TOKEN_ENV],
        ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      });
      io.log(`uploaded ${result.plugin} ${result.version} (${result.digest}): pending, not active`);
      io.log(`activate: ${result.activationUrl}`);
      if (result.next !== '') io.log(result.next);
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
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
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
    env: process.env,
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
    error: (line) => console.error(line),
  });
}
