/**
 * Entry of `apps/gateway/backup.mjs` in the image (bundled by
 * `scripts/build-commands.mjs`). Everything is in `cli.ts`; this file only
 * binds it to the process. Whatever escapes is reported by one fixed line:
 * never an error message or a stack, which could quote a secret held in memory.
 */
import { runBackupCli, UNEXPECTED_FAILURE } from './cli';

try {
  process.exitCode = await runBackupCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
} catch {
  // expected: runBackupCli already answers its own failures; this is the last guard, message withheld
  process.stderr.write(UNEXPECTED_FAILURE);
  process.exitCode = 1;
}
