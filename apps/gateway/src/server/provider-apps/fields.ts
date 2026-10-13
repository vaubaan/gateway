/**
 * Which settings the operator enters for a provider's registered app — derived
 * from the plugin's `CredentialSpec`, never listed by hand (one source of
 * truth for the provider list and for what each provider needs).
 *
 *   oauth2       `client_id`, `client_secret` unless the client is public
 *                (`clientAuthMethod: 'none'`), then the plugin's `appConfigFields`
 *   app-install  the plugin's `appConfigFields` (app id, private key, slug…)
 *   api-key      nothing: the user pastes their own key, no company app exists
 *   ssh-key      nothing: the instance generates the key pair
 */
import type { CredentialField, CredentialSpec } from '@vaubaan/plugin-sdk';

export const CLIENT_ID_FIELD = 'client_id';
export const CLIENT_SECRET_FIELD = 'client_secret';

/** Field names become `instance_config` keys and form input names. */
export const APP_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const CLIENT_ID: CredentialField = {
  name: CLIENT_ID_FIELD,
  label: 'Client ID',
  secret: false,
  help: 'The client identifier of the OAuth app your company registered at the provider.',
};

const CLIENT_SECRET: CredentialField = {
  name: CLIENT_SECRET_FIELD,
  label: 'Client secret',
  secret: true,
  help: 'Stored encrypted with the master key; never shown again and never handed to the plugin.',
};

export function appConfigFieldsOf(spec: CredentialSpec): readonly CredentialField[] {
  switch (spec.kind) {
    case 'oauth2': {
      const base = spec.clientAuthMethod === 'none' ? [CLIENT_ID] : [CLIENT_ID, CLIENT_SECRET];
      const extra = (spec.appConfigFields ?? []).filter(
        (f) => f.name !== CLIENT_ID_FIELD && f.name !== CLIENT_SECRET_FIELD,
      );
      return [...base, ...extra];
    }
    case 'app-install':
      return spec.appConfigFields;
    case 'api-key':
    case 'ssh-key':
      return [];
  }
}

/** True when connecting this provider goes through an app the company registered. */
export function needsProviderApp(spec: CredentialSpec): boolean {
  return appConfigFieldsOf(spec).length > 0;
}

export function isRequired(field: CredentialField): boolean {
  return field.required !== false;
}
