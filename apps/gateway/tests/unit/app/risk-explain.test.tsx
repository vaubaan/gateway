/**
 * The shared pieces every page explains a risk with, rendered to static
 * markup (no browser): the slug carries its kind, the vector strip writes
 * every value and names every axis in full, help starts closed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RiskExplain, RiskIdLink, VectorStrip } from '@/components/risk/RiskExplain';
import { Callout, Help, KindLegend, Slug } from '@/components/ui';
import { ITEM_KINDS } from '@/components/ui/kinds';
import { enumerateCatalog } from '@/server/missions/catalog-view';
import { ACME_CATALOG } from '@/server/missions/testing';

const [risk] = enumerateCatalog(ACME_CATALOG);
if (!risk) throw new Error('the test catalog is empty');

describe('Slug', () => {
  it('carries its kind as an attribute, a glyph and a word for assistive technology', () => {
    const html = renderToStaticMarkup(<Slug kind="tool">github__get_file_contents</Slug>);
    expect(html).toMatch(/^<span[^>]*data-kind="tool"/);
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-kind-label="Tool: "');
    // The name wraps between its words, never inside one, and its text stays the bare name.
    expect(html).toContain('github__<wbr/>get_<wbr/>file_<wbr/>contents');
    expect(html.replace(/<[^>]+>/g, '')).toBe('github__get_file_contents');
  });

  it('is a link when it is given somewhere to go, in a new tab on request', () => {
    const html = renderToStaticMarkup(
      <Slug kind="preset" href="/providers/github#preset-developer" newTab mono={false}>
        Developer
      </Slug>,
    );
    expect(html).toMatch(/^<a[^>]*href="\/providers\/github#preset-developer"/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('data-kind="preset"');
  });

  it('prints a risk id in the risk colour, linked to its catalog entry', () => {
    const html = renderToStaticMarkup(<RiskIdLink riskId="supabase[staging].bulk-row-write" />);
    expect(html).toContain('data-kind="risk"');
    expect(html).toContain('href="/providers/supabase#risk-supabase.bulk-row-write"');
  });

  it('has a legend entry for every kind', () => {
    const html = renderToStaticMarkup(<KindLegend />);
    for (const kind of ITEM_KINDS) expect(html).toContain(`data-kind="${kind}"`);
  });
});

describe('VectorStrip', () => {
  it('writes the six values and names each axis in full for assistive technology', () => {
    const html = renderToStaticMarkup(<VectorStrip vector={risk.vector} />);
    expect(html.match(/role="listitem"/g)).toHaveLength(6);
    expect(html).toContain(`aria-label="Reversibility: ${risk.vector.reversibility}"`);
    expect(html).toContain(`aria-label="Blast radius: ${risk.vector.blast}"`);
    expect(html).toContain(`>${risk.vector.data}<`);
    // The whole profile, spelled out, for hover and keyboard focus.
    expect(html).toContain(`Persistence: ${risk.vector.persistence}`);
    expect(html).not.toContain('tabindex');
    expect(renderToStaticMarkup(<VectorStrip vector={risk.vector} focusable />)).toContain(
      'tabindex="0"',
    );
  });
});

describe('RiskExplain', () => {
  it('explains a risk in three lines: label and class, id and reason, strip', () => {
    const html = renderToStaticMarkup(<RiskExplain risk={risk} />);
    expect(html).toContain(risk.label);
    expect(html).toContain('data-kind="risk"');
    expect(html).toContain(`<summary title="Show the whole reason">${risk.reason}`);
    expect(html).toContain('aria-label="Risk profile"');
  });

  it('leaves the class out of a list that is already grouped by class', () => {
    const tagged = renderToStaticMarkup(<RiskExplain risk={risk} />);
    const plain = renderToStaticMarkup(<RiskExplain risk={risk} kindTag={false} />);
    expect(tagged.length).toBeGreaterThan(plain.length);
  });
});

describe('Help and Callout', () => {
  it('renders help closed, with a button that says so', () => {
    const html = renderToStaticMarkup(
      <Help id="test" line="One line.">
        <p>The rest.</p>
      </Help>,
    );
    expect(html).toContain('One line.');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*>\s*<p>The rest\.<\/p>/);
  });

  it('gives a callout a title, an icon and the role of a note', () => {
    const html = renderToStaticMarkup(
      <Callout tone="warning" title="Fallback entry">
        Counts only for a write no other entry names.
      </Callout>,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('Fallback entry');
    expect(html).toContain('<svg');
  });
});
