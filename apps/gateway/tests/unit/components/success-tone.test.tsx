/**
 * Green is for checklist ticks only (style guide, "Colour"; owner's decision of
 * 2026-10-14): a success callout and a success toast say "done" in the accent.
 * Read from what the components render, so a tone mapping that slides back to the
 * status green fails here.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Callout, ToastCard } from '@/components/ui';

describe('a success is drawn in the accent, never in green', () => {
  it('the ok callout is tinted with the accent', () => {
    const html = renderToStaticMarkup(<Callout tone="ok">Saved.</Callout>);
    expect(html).toContain('bg-primary-soft');
    expect(html).not.toMatch(/allowed|--ok/);
  });

  it('the ok toast marks its check with the accent', () => {
    const html = renderToStaticMarkup(<ToastCard title="Key replaced" tone="ok" />);
    expect(html).toContain('text-primary');
    expect(html).not.toMatch(/allowed|--ok/);
  });
});
