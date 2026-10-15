/**
 * Entry of `apps/gateway/import-v4.mjs` in the image (bundled by
 * `apps/gateway/build-import-v4.mjs`). Everything is in `cli.ts`; this file
 * only binds it to the process.
 */
import { runImportCli } from './cli';

const code = await runImportCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
});
process.exitCode = code;
