/**
 * `npm run generate --workspace @vaubaan/design-tokens`: writes `tokens.css`
 * and `theme.css` at the package root from `src/palette.ts`. Run it after a
 * change of the palette and commit the result; `tests/unit/sheets.test.ts`
 * fails while a sheet differs from its render, and `contrast.test.ts` while a
 * documented pair misses its target.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renderedSheets } from '../src/render.ts';

const ROOT = resolve(import.meta.dirname, '..');

for (const [file, content] of Object.entries(renderedSheets())) {
  writeFileSync(join(ROOT, file), content);
  process.stdout.write(`wrote ${file}\n`);
}
