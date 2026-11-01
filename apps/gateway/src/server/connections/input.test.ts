import { describe, expect, it } from 'vitest';

import {
  cleanName,
  echoOfForm,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  resolveReturnTo,
} from './input';
import { API_KEY_SPEC, PUBLIC_URL } from '../../../tests/support/connections/testing';

describe('readCredentialFields', () => {
  it('trims, splits secret from visible values and skips blank optional fields', () => {
    const read = readCredentialFields(API_KEY_SPEC.fields, {
      token: '  tok-123  ',
      team_id: 'team_abc',
      note: '   ',
      unknown: 'ignored',
    });
    expect(read.problems).toEqual([]);
    expect(read.values).toEqual({ token: 'tok-123', team_id: 'team_abc' });
    expect(read.visible).toEqual({ team_id: 'team_abc' });
  });

  it('names every problem by field label and never echoes a value', () => {
    const read = readCredentialFields(API_KEY_SPEC.fields, { token: '', team_id: 'nope-SECRET' });
    expect(read.problems).toEqual([
      'Access token is required',
      'Team ID does not have the expected format',
    ]);
    expect(read.problems.join(' ')).not.toContain('nope-SECRET');
    // The same problems by field, for a form that marks the field itself.
    expect(read.invalid).toEqual({ token: 'required', team_id: 'format' });
  });
});

describe('echoOfForm — what a refused form is drawn with again', () => {
  it('keeps the name and the non-secret values, and never a secret', () => {
    const echo = echoOfForm(
      API_KEY_SPEC.fields,
      { token: 'tok-SECRET-VALUE', team_id: 'not-a-team', note: '  for the audit  ' },
      '  Acme   sandbox ',
    );
    expect(echo).toEqual({
      name: 'Acme sandbox',
      // A value in error is kept too: the person corrects it instead of typing it again.
      values: { team_id: 'not-a-team', note: 'for the audit' },
      invalid: { team_id: 'format' },
    });
    expect(JSON.stringify(echo)).not.toContain('tok-SECRET-VALUE');
  });

  it('says which field is missing, and keeps nothing of a field left blank', () => {
    expect(echoOfForm(API_KEY_SPEC.fields, { team_id: 'team_abc' }, null)).toEqual({
      name: '',
      values: { team_id: 'team_abc' },
      invalid: { token: 'required' },
    });
  });
});

describe('resolveReturnTo — return URL limited to public_url', () => {
  it('accepts a path and an absolute URL of the public origin', () => {
    expect(resolveReturnTo('/missions/new?step=2#c', PUBLIC_URL)).toBe('/missions/new?step=2#c');
    expect(resolveReturnTo('https://gateway.example.com/accounts', PUBLIC_URL)).toBe('/accounts');
    expect(resolveReturnTo('accounts', PUBLIC_URL)).toBe('/accounts');
  });

  it.each([
    'https://evil.example.net/connections',
    '//evil.example.net/x',
    '/\\evil.example.net/x',
    'http://gateway.example.com/accounts',
    'https://gateway.example.com:8443/x',
    'https://gateway.example.com.evil.example.net/',
    'https://gateway.example.com@evil.example.net/',
    'javascript:alert(1)',
    'data:text/html,x',
    // normalise to a path starting with `//`: another origin once used as a Location
    '/.//a//evil.example.net/x',
    '/x/..//a//evil.example.net',
    'https://gateway.example.com//a//evil.example.net',
    // a browser strips tab / LF / CR before parsing
    '/\t/evil.example.net/x',
    '/\n/evil.example.net/x',
    '/\r\\evil.example.net/x',
  ])('refuses %j', (raw) => {
    expect(resolveReturnTo(raw, PUBLIC_URL)).toBeNull();
  });

  it('answers null for an absent value', () => {
    expect(resolveReturnTo(null, PUBLIC_URL)).toBeNull();
    expect(resolveReturnTo('', PUBLIC_URL)).toBeNull();
  });
});

describe('owner edits', () => {
  it('normalizes a connection or resource name', () => {
    expect(cleanName('  My \n GitHub  ')).toBe('My GitHub');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });

  it('validates environment labels and lets a blank clear the label', () => {
    expect(parseEnvLabel(' Prod ')).toEqual({ ok: true, env: 'prod' });
    expect(parseEnvLabel('')).toEqual({ ok: true, env: null });
    expect(parseEnvLabel('pre-prod-2')).toEqual({ ok: true, env: 'pre-prod-2' });
    expect(parseEnvLabel('2prod').ok).toBe(false);
    expect(parseEnvLabel('prod*').ok).toBe(false);
    expect(parseEnvLabel('prod staging').ok).toBe(false);
  });

  it('offers only string-list metadata keys for editing', () => {
    expect(
      editableMetadataKeys({
        kind: 'domain',
        domain_id: 'd_1',
        internal_domains: [],
        allowlist_addresses: ['a@example.com'],
        mixed: ['a', 1],
        nested: { a: [] },
      }),
    ).toEqual(['allowlist_addresses', 'internal_domains']);
    expect(editableMetadataKeys(null)).toEqual([]);
  });

  it('parses a list value, lower-cased and de-duplicated', () => {
    expect(parseListValue('Acme.com, example.org\n acme.com')).toEqual({
      ok: true,
      list: ['acme.com', 'example.org'],
    });
    expect(parseListValue('   ')).toEqual({ ok: true, list: [] });
    expect(parseListValue('x'.repeat(300)).ok).toBe(false);
    expect(
      parseListValue(Array.from({ length: 201 }, (_, i) => `d${i}.example.com`).join(' ')).ok,
    ).toBe(false);
  });
});
