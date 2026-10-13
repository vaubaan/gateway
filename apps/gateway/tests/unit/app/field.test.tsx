/**
 * Form labels are bound to their controls: `Field` with `htmlFor` renders a
 * real `<label for>`; without it the wrapper is a `group` named by the label.
 * Rendered to static markup, no browser.
 */
import type { CredentialField } from '@vaubaan/plugin-sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CredentialFieldInputs, credentialFieldId } from '@/components/connections/parts';
import { Field, Input } from '@/components/ui';

/** `for` of every `<label>` and `id` of every control in the markup. */
function bindings(html: string): { labels: string[]; controls: string[] } {
  const labels = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1] ?? '');
  const controls = [...html.matchAll(/<(?:input|textarea|select)[^>]*\sid="([^"]+)"/g)].map(
    (m) => m[1] ?? '',
  );
  return { labels, controls };
}

describe('Field', () => {
  it('binds its label to the one control named by htmlFor', () => {
    const html = renderToStaticMarkup(
      <Field label="Issuer URL" htmlFor="idp-issuer">
        <Input id="idp-issuer" name="issuer" />
      </Field>,
    );
    expect(bindings(html)).toEqual({ labels: ['idp-issuer'], controls: ['idp-issuer'] });
    expect(html).toMatch(/<label[^>]*for="idp-issuer"[^>]*>Issuer URL<\/label>/);
    expect(html).not.toContain('role="group"');
  });

  it('is a group named by its label when it holds several controls', () => {
    const html = renderToStaticMarkup(
      <Field label="Claim mapping">
        <Input name="claim_sub" aria-label="Subject claim" />
        <Input name="claim_email" aria-label="Email claim" />
      </Field>,
    );
    const labelledBy = /role="group" aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}">Claim mapping</div>`);
    expect(html).not.toContain('<label');
  });

  it('has no group role and no label element without a label', () => {
    const html = renderToStaticMarkup(
      <Field hint="A hint">
        <Input name="x" aria-label="X" />
      </Field>,
    );
    expect(html).not.toContain('role=');
    expect(html).not.toContain('<label');
    expect(html).toContain('A hint');
  });

  it('shows the error in place of the hint', () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="n" hint="A hint" error="Too long">
        <Input id="n" name="name" />
      </Field>,
    );
    expect(html).toContain('Too long');
    expect(html).not.toContain('A hint');
  });
});

describe('CredentialFieldInputs', () => {
  const FIELDS: readonly CredentialField[] = [
    { name: 'client_id', label: 'Client ID', secret: false },
    { name: 'client_secret', label: 'Client secret', secret: true },
    { name: 'private_key', label: 'Private key (PEM)', secret: true, required: false },
  ];

  it('binds every label to its input, textarea included', () => {
    const html = renderToStaticMarkup(<CredentialFieldInputs idPrefix="app-a" fields={FIELDS} />);
    const expected = FIELDS.map((field) => credentialFieldId('app-a', field.name));
    expect(bindings(html)).toEqual({ labels: expected, controls: expected });
    expect(html).toContain('<textarea');
  });

  it('keeps ids unique when two lists with the same field names share a page', () => {
    const html = renderToStaticMarkup(
      <>
        <CredentialFieldInputs idPrefix="provider-app-a" fields={FIELDS} />
        <CredentialFieldInputs idPrefix="provider-app-b" fields={FIELDS} />
      </>,
    );
    const { labels, controls } = bindings(html);
    expect(controls).toHaveLength(FIELDS.length * 2);
    expect(new Set(controls).size).toBe(controls.length);
    expect(labels).toEqual(controls);
  });
});
