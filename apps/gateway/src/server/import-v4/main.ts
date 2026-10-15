/**
 * Entry of `apps/gateway/import-v4.mjs` in the image (bundled by
 * `scripts/build-import-v4.mjs`). Everything is in `cli.ts`; this file only
 * binds it to the process. Whatever escapes is reported by one fixed line:
 * never an error message or a stack, which could quote a secret held in memory.
 */
import { runImportCli, UNEXPECTED_FAILURE } from './cli';

try {
  process.exitCode = await runImportCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
} catch {
  process.stderr.write(UNEXPECTED_FAILURE);
  process.exitCode = 1;
}
