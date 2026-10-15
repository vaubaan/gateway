#!/usr/bin/env node
// Exports one organization of the v4 SaaS as the bundle the v5 importer reads
// (ADR import-from-v4-one-shot-importer; handbook docs/handbook/import-from-v4.md).
//
//   node scripts/export-v4.mjs --org fidi --ssh-host vps-fidi \
//     --ssh-host-key vps-fidi=SHA256:… | <importer in the container> --owner … [--apply]
//
// Runs on the operator's machine, from the repository. One read-only psql
// session; the database password goes to psql through its environment, never
// its arguments. The bundle — decrypted secrets included — is written to stdout
// and nowhere else: no temporary file, no log. Counts go to stderr.
//
// Exit codes: 0 written, 1 refused (message on stderr), 64 usage.

import { spawn } from 'node:child_process';
import { fstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBundle,
  createV4Decryptor,
  ExportError,
  exportSql,
  parseArgs,
  parseEnvFile,
  requireEnv,
  summaryOf,
  USAGE,
  UsageError,
} from './export-v4-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs the export statement in psql and returns the JSON document it prints.
 * @param {string} sql
 * @param {Record<string, string>} variables
 * @param {Record<string, string>} pgEnv
 * @returns {Promise<import('./export-v4-lib.mjs').RawExport>}
 */
function runPsql(sql, variables, pgEnv) {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  args.push('-f', '-');
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', args, {
      env: { ...process.env, ...pgEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) =>
      reject(
        new ExportError(
          `psql could not be started (${error.message}): install the PostgreSQL client`,
        ),
      ),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new ExportError(
            `psql failed (exit ${code}): ${Buffer.concat(err).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      const text = Buffer.concat(out).toString('utf8').trim();
      try {
        resolvePromise(
          JSON.parse(
            text
              .split('\n')
              .filter((l) => l.trim() !== '')
              .pop() ?? '',
          ),
        );
      } catch {
        reject(new ExportError('psql did not return the expected JSON document'));
      }
    });
    child.stdin.end(sql);
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stderr.write(USAGE);
    return 0;
  }
  const { org, sshHosts, sshHostKeys } = parsed.args;
  // The bundle holds decrypted secrets: a terminal (its scrollback) or a file is
  // a disk. It goes into a pipe or nowhere, checked before anything is read.
  if (process.stdout.isTTY || fstatSync(1).isFile()) {
    throw new UsageError(
      'stdout is a terminal or a file: the bundle holds secrets, pipe this command into the importer',
    );
  }
  let envText;
  try {
    envText = readFileSync(resolve(ROOT, '.env'), 'utf8');
  } catch {
    throw new ExportError(`no .env at the repository root (${ROOT})`);
  }
  const env = requireEnv(parseEnvFile(envText));
  const decryptor = await createV4Decryptor(env.ENCRYPTION_MASTER_KEY);
  const raw = await runPsql(
    exportSql(),
    { org, hosts: sshHosts.join(',') },
    {
      PGHOST: env.SUPABASE_CORE_POOLER_HOST,
      PGPORT: '5432',
      PGDATABASE: 'postgres',
      PGUSER: `postgres.${env.SUPABASE_CORE_PROJECT_REF}`,
      PGPASSWORD: env.VAUBAAN_CORE_DB_PASSWORD,
      PGSSLMODE: 'require',
      PGAPPNAME: 'vaubaan-export-v4',
    },
  );
  const bundle = buildBundle(raw, decryptor, { org, sshHosts, sshHostKeys }, new Date());
  process.stdout.write(`${JSON.stringify(bundle)}\n`);
  process.stderr.write(`${summaryOf(bundle)}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof ExportError) {
      process.stderr.write(`export-v4: ${error.message}\n`);
      process.exitCode = error instanceof UsageError ? 64 : 1;
      return;
    }
    process.stderr.write(
      'export-v4: unexpected failure (details withheld: they may quote a secret)\n',
    );
    process.exitCode = 1;
  },
);
