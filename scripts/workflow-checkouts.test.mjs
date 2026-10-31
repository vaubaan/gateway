// Every checkout in the workflows leaves no token in the working copy
// (`persist-credentials: false`): a later step, or a script it runs, cannot push
// with the job's token (security audit 2026-10-31, L13). No network: the
// workflow files are read as text.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

/**
 * The `actions/checkout` steps of a workflow, each with the lines of its block.
 * @param {string} text
 * @returns {{ line: number, block: string[] }[]}
 */
function checkouts(text) {
  const lines = text.split('\n');
  /** @type {{ line: number, block: string[] }[]} */
  const steps = [];
  lines.forEach((line, index) => {
    const at = line.indexOf('- uses: actions/checkout@');
    if (at < 0) return;
    /** @type {string[]} */
    const block = [];
    for (const next of lines.slice(index + 1)) {
      const indent = next.length - next.trimStart().length;
      if (next.trim() !== '' && indent <= at) break;
      block.push(next.trim());
    }
    steps.push({ line: index + 1, block });
  });
  return steps;
}

describe('workflow checkouts', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

  it('finds the checkouts it checks', () => {
    const all = files.flatMap((name) => checkouts(readFileSync(join(WORKFLOWS, name), 'utf8')));
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(files)('%s: every checkout sets persist-credentials: false', (name) => {
    const missing = checkouts(readFileSync(join(WORKFLOWS, name), 'utf8'))
      .filter((step) => !step.block.includes('persist-credentials: false'))
      .map((step) => `line ${step.line}`);
    expect(missing).toEqual([]);
  });
});
