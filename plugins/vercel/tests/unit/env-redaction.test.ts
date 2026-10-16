/**
 * SEC 2026-10-15 (C1 sweep) : the encrypted read of `list_env_vars`
 * (`vercel.read-env-var`, `data: metadata`) returns keys and descriptions,
 * never a value — `plain` vars included. `decrypt=true` is the plaintext read
 * (`vercel.read-env-var-plaintext`, `data: secret`) and returns the answer as
 * it is.
 */
import { describe, expect, test } from 'vitest';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { VERCEL_API_BASE, vercelPlugin } from '../../src/index.ts';
import { REDACTED_VALUE, redactEncryptedEnvListing } from '../../src/redact.ts';
import { ctx, TEAM, text } from './fixtures.ts';

const ENV_URL = `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=${TEAM}`;

const LISTING = {
  envs: [
    {
      id: 'env_1',
      key: 'DATABASE_URL',
      type: 'plain',
      value: 'postgres://u:pw@db',
      target: ['production'],
    },
    { id: 'env_2', key: 'STRIPE_KEY', type: 'encrypted', value: 'ciphertext', vsmValue: 'vsm' },
    { id: 'env_3', key: 'EMPTY', type: 'plain', value: '' },
  ],
  pagination: { count: 3, next: null, prev: null },
};

describe('redactEncryptedEnvListing', () => {
  test('keeps keys and descriptions, replaces every value', () => {
    expect(redactEncryptedEnvListing(LISTING)).toEqual({
      envs: [
        {
          id: 'env_1',
          key: 'DATABASE_URL',
          type: 'plain',
          value: REDACTED_VALUE,
          target: ['production'],
        },
        {
          id: 'env_2',
          key: 'STRIPE_KEY',
          type: 'encrypted',
          value: REDACTED_VALUE,
          vsmValue: REDACTED_VALUE,
        },
        { id: 'env_3', key: 'EMPTY', type: 'plain', value: '' },
      ],
      pagination: { count: 3, next: null, prev: null },
    });
  });

  test('a bare list and a single entry are redacted too', () => {
    expect(redactEncryptedEnvListing([{ key: 'A', value: 'x' }])).toEqual([
      { key: 'A', value: REDACTED_VALUE },
    ]);
    expect(redactEncryptedEnvListing({ key: 'A', value: 'x' })).toEqual({
      key: 'A',
      value: REDACTED_VALUE,
    });
  });
});

describe('executeVercel — list_env_vars', () => {
  test('without decrypt : no value leaves the gateway', async () => {
    const fetch = mockFetch([{ method: 'GET', url: ENV_URL, body: LISTING, times: 1 }]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', {
      projectId: 'prj_abc',
    });
    const out = text(result);
    expect(out).toContain('DATABASE_URL');
    expect(out).not.toContain('postgres://u:pw@db');
    expect(out).not.toContain('ciphertext');
  });

  test('with decrypt=true (the plaintext risk) : the answer is returned as it is', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${ENV_URL}&decrypt=true`, body: LISTING, times: 1 },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', {
      projectId: 'prj_abc',
      decrypt: true,
    });
    expect(text(result)).toContain('postgres://u:pw@db');
  });
});
