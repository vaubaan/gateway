#!/usr/bin/env node
/**
 * Bundles the operator commands into one ES module each, placed inside the
 * standalone output, beside `server.js`:
 *
 *   .next/standalone/apps/gateway/import-v4.mjs   (src/server/import-v4/main.ts)
 *   .next/standalone/apps/gateway/reseal.mjs      (src/server/reseal/main.ts)
 *   .next/standalone/apps/gateway/backup.mjs      (src/server/backup/main.ts)
 *   .next/standalone/apps/gateway/restore.mjs     (src/server/restore/main.ts)
 *
 * The image copies the standalone tree whole (deploy/docker/Dockerfile), so
 * the commands ship with the server, at `/app/apps/gateway/<name>.mjs`
 * (ADR import-from-v4-one-shot-importer D1, ADR master-key-rotation-reseals-every-blob).
 *
 * - The native addons stay external: they are already in the standalone
 *   `node_modules` because the server needs them (better-sqlite3, argon2,
 *   ssh2 — `next.config.ts`).
 * - Everything else (workspace packages as TypeScript, zod, libsodium, …) is
 *   bundled, so the command does not depend on what Next's tracer chose to
 *   copy.
 * - `import.meta.url` is rewritten, module by module, to the URL the module
 *   has in the repository, relative to the bundle. The standalone tree has the
 *   repository's layout, so a plugin still finds its `risk-catalog.yaml` next
 *   to itself (`catalogPathNextTo`, traced by `next.config.ts`) and the store
 *   its migrations.
 *
 * Run after `next build` (the `build` script of `apps/gateway/package.json`).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = resolve(repoRoot, 'apps/gateway');
const standaloneApp = resolve(appDir, '.next/standalone/apps/gateway');

/** Each command: its entry in the source tree and the file it becomes. */
const COMMANDS = [
  { entry: 'src/server/import-v4/main.ts', out: 'import-v4.mjs' },
  { entry: 'src/server/reseal/main.ts', out: 'reseal.mjs' },
  { entry: 'src/server/backup/main.ts', out: 'backup.mjs' },
  { entry: 'src/server/restore/main.ts', out: 'restore.mjs' },
];

/** Native addons the standalone output already carries; never bundled. */
const EXTERNAL = ['better-sqlite3', 'argon2', 'ssh2', 'cpu-features'];

if (!existsSync(standaloneApp)) {
  console.error(
    `build-commands: ${relative(repoRoot, standaloneApp)} is missing: run next build first`,
  );
  process.exit(1);
}
mkdirSync(standaloneApp, { recursive: true });

/** The original location of every bundled module, as seen from the bundle. */
const keepModuleUrl = {
  name: 'keep-module-url',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(ts|mts|js|mjs)$/ }, async (args) => {
      if (args.path.includes('/node_modules/')) return undefined;
      const source = await readFile(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return undefined;
      // The bundle sits in `apps/gateway` of a tree laid out like the
      // repository: the module's path relative to `apps/gateway` holds in both.
      const fromBundle = relative(appDir, args.path).split('\\').join('/');
      const declaration = `const __vaubaanModuleUrl = new URL(${JSON.stringify(fromBundle)}, import.meta.url).href;\n`;
      return {
        contents: declaration + source.replaceAll('import.meta.url', '__vaubaanModuleUrl'),
        loader: args.path.endsWith('ts') ? 'ts' : 'js',
      };
    });
  },
};

for (const command of COMMANDS) {
  const outfile = resolve(standaloneApp, command.out);
  await build({
    entryPoints: [resolve(appDir, command.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    tsconfig: resolve(appDir, 'tsconfig.json'),
    external: EXTERNAL,
    plugins: [keepModuleUrl],
    // CommonJS dependencies call require(); an ES module has none of its own.
    banner: {
      js: "import { createRequire as __vaubaanCreateRequire } from 'node:module'; const require = __vaubaanCreateRequire(import.meta.url);",
    },
    // Licence notices of the bundled packages are kept, at the end of the file.
    legalComments: 'eof',
    logLevel: 'warning',
  });
  console.log(`build-commands: ${relative(repoRoot, outfile)}`);
}
