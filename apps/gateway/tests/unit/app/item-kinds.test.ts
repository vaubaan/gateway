import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCurrentSection } from '../../../src/components/shell/nav';
import { ITEM_KINDS, ITEM_KIND_WORDS } from '../../../src/components/ui/kinds';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(resolve(HERE, '../../../src/styles/tokens.css'), 'utf8');

/** The body of the first rule whose selector list ends with `selector`. */
function ruleBody(selector: string): string {
  const start = TOKENS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return TOKENS.slice(start, TOKENS.indexOf('}', start));
}

describe('the type colour system', () => {
  it('names every kind, with a label and a meaning for the legend', () => {
    for (const kind of ITEM_KINDS) {
      expect(ITEM_KIND_WORDS[kind].label).not.toBe('');
      expect(ITEM_KIND_WORDS[kind].meaning.endsWith('.')).toBe(true);
    }
    expect(new Set(ITEM_KINDS).size).toBe(ITEM_KINDS.length);
  });

  it('gives every kind its three tokens in both themes, and the scope that applies them', () => {
    const dark = ruleBody(":root[data-theme='dark']");
    const light = ruleBody(":root[data-theme='light']");
    for (const kind of ITEM_KINDS) {
      for (const part of ['rail', 'bg', 'fg']) {
        expect(dark, `dark ${kind} ${part}`).toContain(`--type-${kind}-${part}:`);
        expect(light, `light ${kind} ${part}`).toContain(`--type-${kind}-${part}:`);
      }
      const scope = ruleBody(`[data-kind='${kind}']`);
      expect(scope).toContain(`--kind-rail: var(--type-${kind}-rail)`);
      expect(scope).toContain(`--kind-bg: var(--type-${kind}-bg)`);
      expect(scope).toContain(`--kind-fg: var(--type-${kind}-fg)`);
    }
  });

  it('never borrows a status hue: a kind is not a state', () => {
    const semantic = `${ruleBody(":root[data-theme='dark']")}${ruleBody(":root[data-theme='light']")}`;
    const typeLines = semantic.split('\n').filter((line) => line.includes('--type-'));
    expect(typeLines.length).toBe(ITEM_KINDS.length * 3 * 2);
    for (const line of typeLines) {
      expect(line).not.toMatch(/var\(--(blue|green|amber|red)-/);
    }
  });

  it('gives each kind a hue of its own', () => {
    const light = ruleBody(":root[data-theme='light']");
    const rails = ITEM_KINDS.map((kind) => {
      const match = new RegExp(`--type-${kind}-rail: var\\(--([a-z]+)-600\\)`).exec(light);
      if (!match?.[1]) throw new Error(`no rail for ${kind}`);
      return match[1];
    });
    expect(new Set(rails).size).toBe(ITEM_KINDS.length);
  });
});

describe('the current section of the application bar', () => {
  it('is the entry the path is under, and no other', () => {
    expect(isCurrentSection('/missions', '/missions')).toBe(true);
    expect(isCurrentSection('/missions/abc/session', '/missions')).toBe(true);
    expect(isCurrentSection('/missions-archive', '/missions')).toBe(false);
    expect(isCurrentSection('/providers/github', '/missions')).toBe(false);
  });
});
