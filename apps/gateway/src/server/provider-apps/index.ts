/**
 * Provider apps — the OAuth client a company declares for a service that
 * connects that way (spec §4.3, §7.1). Handbook: docs/handbook/connections.md.
 */
export {
  APP_FIELD_NAME_PATTERN,
  appConfigFieldsOf,
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  isRequired,
  needsProviderApp,
} from './fields';
export {
  fileAppConfig,
  PROVIDER_APP_KEY_PREFIX,
  ProviderAppError,
  ProviderAppNotConfigured,
  providerAppKey,
  ProviderAppsService,
  type ProviderAppSource,
  type ProviderAppStatus,
} from './service';
