/**
 * Green is for checklist ticks only (style guide, "Colour"; owner's decision of
 * 2026-10-14): a success callout and a success toast say "done" in the accent.
 * Read from the stylesheets themselves, so a tone mapping that slides back to the
 * status green fails here.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/components/ui');

/** The declarations of one rule of a stylesheet, by its exact selector. */
function ruleOf(file: string, selector: string): string {
  const css = readFileSync(resolve(UI, file), 'utf8');
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} not found in ${file}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('a success is drawn in the accent, never in green', () => {
  it('the ok callout is tinted with the accent', () => {
    const rule = ruleOf('Callout.module.css', '.tone_ok');
    expect(rule).toContain('var(--primary');
    expect(rule).not.toMatch(/var\(--ok/);
  });

  it('the ok toast marks its check with the accent', () => {
    const rule = ruleOf('Toast.module.css', '.tone_ok .icon');
    expect(rule).toContain('var(--primary)');
    expect(rule).not.toMatch(/var\(--ok/);
  });
});
