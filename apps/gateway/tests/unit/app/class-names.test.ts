/**
 * `cn` knows the shared sizes are sizes (`lib/utils.ts`): merged beside a
 * colour, neither is dropped; two sizes still merge into the later one. The
 * list is the theme's own `--text-*` names.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cn, TEXT_SIZES } from '@/lib/utils';

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
    expect(cn('text-small', 'text-muted-foreground')).toBe('text-small text-muted-foreground');
    expect(cn('text-body text-primary', 'text-title')).toBe('text-primary text-title');
  });

  it('knows every size of the shared theme', () => {
    const sizes = [...THEME.matchAll(/--text-([a-z]+):/g)].map((match) => match[1]);
    expect([...TEXT_SIZES].sort()).toEqual([...new Set(sizes)].sort());
  });
});
