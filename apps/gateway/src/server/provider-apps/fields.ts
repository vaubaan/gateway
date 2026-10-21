/**
 * Which settings the operator enters for the OAuth client of a service that
 * connects that way — derived from the plugin's `CredentialSpec`, never
 * listed by hand (one source of truth for the provider list and for what
 * each provider needs).
 *
 *   oauth2    `client_id`, `client_secret` unless the client is public
 *             (`clientAuthMethod: 'none'`), then the plugin's `appConfigFields`;
 *             nothing when the gateway registers its own client at the
 *             service (`clientRegistration`, ADR
 *             oauth-client-registered-by-the-gateway)
 *   api-key   nothing: the person pastes their own key
 *   ssh-key   nothing: the instance generates the key pair
 */
import {
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  type CredentialField,
  type CredentialSpec,
} from '@vaubaan/plugin-sdk';

// One definition, in the SDK: the plugin contract names these two keys.
export { CLIENT_ID_FIELD, CLIENT_SECRET_FIELD };

/** Field names become `instance_config` keys and form input names. */
export const APP_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const CLIENT_ID: CredentialField = {
  name: CLIENT_ID_FIELD,
  label: 'Client ID',
  secret: false,
  help: 'The client identifier of the OAuth client your company declared at the service.',
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
      if (spec.clientRegistration !== undefined) return [];
      const base = spec.clientAuthMethod === 'none' ? [CLIENT_ID] : [CLIENT_ID, CLIENT_SECRET];
      const extra = (spec.appConfigFields ?? []).filter(
        (f) => f.name !== CLIENT_ID_FIELD && f.name !== CLIENT_SECRET_FIELD,
      );
      return [...base, ...extra];
    }
    case 'api-key':
    case 'ssh-key':
      return [];
  }
}

/** True when connecting this provider goes through an OAuth client the company declares. */
export function needsProviderApp(spec: CredentialSpec): boolean {
  return appConfigFieldsOf(spec).length > 0;
}

export function isRequired(field: CredentialField): boolean {
  return field.required !== false;
}
