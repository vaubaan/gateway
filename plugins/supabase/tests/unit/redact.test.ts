/**
 * SEC 2026-10-15 C1 : no Supabase read returns a secret value.
 *
 * `list_function_secrets` and `get_auth_config` (and the answer of
 * `update_auth_config`, which is the whole config again) go through an
 * allow-list of non-secret fields ; every other field that holds a value is
 * replaced by `REDACTED_VALUE`, a field Supabase adds tomorrow included.
 */
import { describe, expect, test } from 'vitest';

import type { ExecuteContext, OAuth2Secret, Resource } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  AUTH_CONFIG_PUBLIC_FIELDS,
  REDACTED_VALUE,
  SUPABASE_API_BASE,
  redactAuthConfig,
  redactFunctionSecrets,
  supabasePlugin,
} from '../../src/index.ts';

const REF = 'tlqgxnezmthbpzhdwxgi';
const MGMT = `${SUPABASE_API_BASE}/projects/${REF}`;

const project: Resource = { provider: 'supabase', ref: REF, displayName: 'Acme / app' };
const credential: OAuth2Secret = {
  kind: 'oauth2',
  accessToken: 'sbp_access',
  refreshToken: 'sbp_refresh',
  expiresAt: '2026-10-13T12:00:00.000Z',
  scopes: ['all'],
  metadata: {},
};
const execCtx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
  credential,
  appConfig: { client_id: 'cid', client_secret: 'csecret' },
  fetch,
  resources: [project],
});
const textOf = (result: { content: readonly unknown[] }) =>
  (result.content[0] as { text: string }).text;

/** An auth config answer as Supabase sends it, secrets in clear. */
const AUTH_CONFIG = {
  site_url: 'https://app.example',
  jwt_exp: 3600,
  disable_signup: false,
  external_google_enabled: true,
  external_google_client_id: 'google-client-id',
  external_google_secret: 'GOCSPX-google-secret',
  external_github_secret: 'gh-oauth-secret',
  smtp_host: 'smtp.example',
  smtp_user: 'mailer',
  smtp_pass: 'smtp-password',
  hook_send_email_uri: 'https://hooks.example/send',
  hook_send_email_secrets: 'v1,whsec_hook-secret',
  sms_twilio_account_sid: 'AC123',
  sms_twilio_auth_token: 'twilio-auth-token',
  sms_vonage_api_secret: 'vonage-secret',
  sms_test_otp: '33612345678=123456',
  security_captcha_secret: 'captcha-secret',
  nimbus_oauth_client_secret: 'nimbus-secret',
  external_apple_secret: null,
  external_azure_secret: '',
  // A field the allow-list does not know : redacted by default.
  external_newprovider_private_signing_material: 'tomorrow-secret',
};

const SECRET_VALUES = [
  'GOCSPX-google-secret',
  'gh-oauth-secret',
  'smtp-password',
  'v1,whsec_hook-secret',
  'twilio-auth-token',
  'vonage-secret',
  '33612345678=123456',
  'captcha-secret',
  'nimbus-secret',
  'tomorrow-secret',
];

describe('redactAuthConfig', () => {
  test('keeps the settings, replaces every secret value, keeps "not set" as it is', () => {
    expect(redactAuthConfig(AUTH_CONFIG)).toEqual({
      site_url: 'https://app.example',
      jwt_exp: 3600,
      disable_signup: false,
      external_google_enabled: true,
      external_google_client_id: 'google-client-id',
      external_google_secret: REDACTED_VALUE,
      external_github_secret: REDACTED_VALUE,
      smtp_host: 'smtp.example',
      smtp_user: 'mailer',
      smtp_pass: REDACTED_VALUE,
      hook_send_email_uri: 'https://hooks.example/send',
      hook_send_email_secrets: REDACTED_VALUE,
      sms_twilio_account_sid: 'AC123',
      sms_twilio_auth_token: REDACTED_VALUE,
      sms_vonage_api_secret: REDACTED_VALUE,
      sms_test_otp: REDACTED_VALUE,
      security_captcha_secret: REDACTED_VALUE,
      nimbus_oauth_client_secret: REDACTED_VALUE,
      external_apple_secret: null,
      external_azure_secret: '',
      external_newprovider_private_signing_material: REDACTED_VALUE,
    });
  });

  test('the allow-list names no field that looks like a secret', () => {
    const secretLike = /(_secret|_secrets|_pass|_auth_token|_api_key|_api_secret|_access_key)$/;
    const leaks = [...AUTH_CONFIG_PUBLIC_FIELDS].filter(
      (f) => secretLike.test(f) || f === 'sms_test_otp',
    );
    expect(leaks).toEqual([]);
  });

  test('an answer of an unexpected shape is redacted whole', () => {
    expect(redactAuthConfig('a string')).toBe(REDACTED_VALUE);
    expect(redactAuthConfig([{ smtp_pass: 'x' }])).toBe(REDACTED_VALUE);
    expect(redactAuthConfig(null)).toBeNull();
  });
});

describe('redactFunctionSecrets', () => {
  test('keeps name and updated_at, never the value ; unknown fields are redacted', () => {
    expect(
      redactFunctionSecrets([
        { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'eyJ.service_role', updated_at: '2026-10-01' },
        { name: 'SUPABASE_DB_URL', value: 'postgresql://postgres:pw@db', digest: 'abc' },
      ]),
    ).toEqual([
      { name: 'SUPABASE_SERVICE_ROLE_KEY', value: REDACTED_VALUE, updated_at: '2026-10-01' },
      { name: 'SUPABASE_DB_URL', value: REDACTED_VALUE, digest: REDACTED_VALUE },
    ]);
  });

  test('an empty answer stays empty', () => {
    expect(redactFunctionSecrets([])).toEqual([]);
    expect(redactFunctionSecrets(null)).toBeNull();
  });
});

describe('executeSupabase — no read returns a secret value', () => {
  test('list_function_secrets returns names, never values', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${MGMT}/secrets`,
        body: [
          { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'eyJ.service_role.secret' },
          { name: 'SUPABASE_DB_URL', value: 'postgresql://postgres:db-password@db.x' },
        ],
        times: 1,
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__list_function_secrets', {
      project_ref: REF,
    });
    const text = textOf(result);
    expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(text).not.toContain('eyJ.service_role.secret');
    expect(text).not.toContain('db-password');
  });

  test.each([
    ['supabase__get_auth_config', 'GET', {}],
    ['supabase__update_auth_config', 'PATCH', { config: { site_url: 'https://app.example' } }],
  ] as const)('%s returns the settings, never a secret', async (tool, method, args) => {
    const fetch = mockFetch([{ method, url: `${MGMT}/config/auth`, body: AUTH_CONFIG, times: 1 }]);
    const result = await supabasePlugin.execute(execCtx(fetch), tool, {
      project_ref: REF,
      ...args,
    });
    const text = textOf(result);
    expect(text).toContain('google-client-id');
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });
});
