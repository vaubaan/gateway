/**
 * Writes `plugins/vaubaan/src/tool-schemas.json`: the JSON Schema of the
 * arguments of each `vaubaan__*` tool, converted from the host's zod schemas
 * (`src/server/vaubaan/inputs.ts`). Run `npm run vaubaan:schemas` in
 * `apps/gateway` after changing one of them (the mission draft included);
 * `inputs.test.ts` fails until the file matches.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { toolSchemasDocument } from '../src/server/vaubaan/inputs';

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/vaubaan/src/tool-schemas.json',
);
// Written as the repository's formatter writes it, so `format:check` passes as is.
const options = (await resolveConfig(target)) ?? {};
writeFileSync(
  target,
  await format(JSON.stringify(toolSchemasDocument()), { ...options, filepath: target }),
);
process.stdout.write(`wrote ${target}\n`);
