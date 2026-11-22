/**
 * `cn` knows the shared sizes are sizes (`src/lib/utils.ts`): merged beside a
 * colour, neither is dropped (the Button's variants rely on it). The list is
 * the theme's own `--text-*` names.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cn, TEXT_SIZES } from '../../../src/lib/utils';

const THEME = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/design-tokens/theme.css',
  ),
  'utf8',
);

describe('cn', () => {
  it('keeps a shared size beside a colour', () => {
    expect(cn('text-caption', 'text-foreground')).toBe('text-caption text-foreground');
    expect(cn('text-display', 'text-primary')).toBe('text-display text-primary');
    expect(cn('text-body', 'text-title')).toBe('text-title');
  });

  it('knows every size of the shared theme', () => {
    const sizes = [...THEME.matchAll(/--text-([a-z]+):/g)].map((match) => match[1]);
    expect([...TEXT_SIZES].sort()).toEqual([...new Set(sizes)].sort());
  });
});
