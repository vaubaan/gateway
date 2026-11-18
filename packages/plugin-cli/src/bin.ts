#!/usr/bin/env node
/**
 * The published `vaubaan-plugin` command: runs the command line, always. `cli.ts` also
 * runs itself when executed directly (`tsx packages/plugin-cli/src/cli.ts` in this
 * repository); bundled for npm, its code lands in a shared chunk where that check
 * cannot tell, so the package's `bin` is this file (scripts/package.ts).
 */
import { run } from './cli.ts';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
  error: (line) => console.error(line),
});
