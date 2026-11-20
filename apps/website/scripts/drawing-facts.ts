/**
 * Writes `drawings/facts.json`, what the site's drawings read from the risk
 * catalogs (`src/content/drawing-facts.ts`). Run it, then the drawings'
 * generator, when a test says the facts changed:
 *
 *   npx tsx apps/website/scripts/drawing-facts.ts && python3 apps/website/drawings/gen.py
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DRAWING_FACTS_FILE, drawingFacts } from '../src/content/drawing-facts';
import { loadPlugins } from '../src/content/plugins';
import { REPO_ROOT } from '../src/content/repo';

async function main(): Promise<void> {
  const facts = drawingFacts(await loadPlugins(REPO_ROOT));
  writeFileSync(join(REPO_ROOT, DRAWING_FACTS_FILE), `${JSON.stringify(facts, null, 2)}\n`);
  process.stdout.write(`wrote ${DRAWING_FACTS_FILE}\n`);
}

void main();
