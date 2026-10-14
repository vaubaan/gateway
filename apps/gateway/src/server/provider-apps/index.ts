/**
 * Provider apps — the company's registered app per provider (spec §4.3,
 * §4.2 Administration). Handbook: docs/handbook/connections.md.
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
  acceptUnverifiedKey,
  fileAppConfig,
  PROVIDER_APP_FLAG_PREFIX,
  PROVIDER_APP_KEY_PREFIX,
  ProviderAppError,
  ProviderAppNotConfigured,
  providerAppKey,
  ProviderAppsService,
  type InstallVerification,
  type ProviderAppSource,
  type ProviderAppStatus,
} from './service';
export { registrationKey, type AppRegistrationRecord } from './service';
export {
  AppRegistrationError,
  AppRegistrationService,
  REGISTRATION_ERROR_CODES,
  REGISTRATION_TTL_MS,
  registrationMessage,
  registrationReturnPath,
  type AppRegistrationDeps,
  type PendingRegistrationView,
  type RegistrationActor,
  type RegistrationChoice,
  type RegistrationErrorCode,
} from './registration';
