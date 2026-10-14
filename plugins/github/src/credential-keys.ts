/**
 * Keys of the company's GitHub App configuration (`ctx.appConfig`) and
 * GitHub's web origin — one source for the credential spec
 * (`credential.ts`), the manifest flow (`app-manifest.ts`) and the readers.
 */

import { CLIENT_ID_FIELD, CLIENT_SECRET_FIELD } from '@vaubaan/plugin-sdk';

/** Keys of `ctx.appConfig` for this provider. */
export const GITHUB_APP_CONFIG = {
  appId: 'app_id',
  privateKey: 'private_key',
  appSlug: 'app_slug',
  /** Used by the host only, to verify installations ; `clientSecret` never reaches this plugin. */
  clientId: CLIENT_ID_FIELD,
  clientSecret: CLIENT_SECRET_FIELD,
} as const;

/** GitHub's web origin : the installation page, the OAuth token endpoint, the App registration. */
export const GITHUB_WEB_BASE = 'https://github.com';
