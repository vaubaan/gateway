/**
 * Redaction of the secret values some Supabase Management API answers carry.
 *
 * Handbook : docs/handbook/providers/supabase.md, Invariants, "Answers
 * that carry secrets".
 *
 * Two reads answer with the project's secrets in clear : `GET
 * /projects/{ref}/secrets` (every edge-function secret with its `value` —
 * `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` among them) and `GET
 * /projects/{ref}/config/auth` (OAuth client secrets, SMTP password, hook
 * secrets, SMS provider tokens…). Both are priced as `supabase.read-data`,
 * the risk most missions hold, so neither may return a secret value ; nor
 * may the answer of `PATCH /config/auth`, which is the whole config again.
 *
 * The rule is an **allow-list** : a field is returned as it is only when it
 * is named below as non-secret. Any other field — a secret the Supabase
 * OpenAPI document lists today, or a field Supabase adds tomorrow — is
 * replaced by `REDACTED_VALUE` when it holds a value. An empty value (`null`,
 * absent, `''`) stays as it is : it says "not set", which is no secret and
 * is what an agent needs to know.
 *
 * Source of the allow-list : the `AuthConfigResponse_Output` schema of the
 * public Supabase Management API OpenAPI document
 * (https://api.supabase.com/api/v1-json, read on 2026-10-15), minus every
 * field ending in `_secret`, `_secrets`, `_pass`, `_auth_token`, `_api_key`,
 * `_api_secret` or `_access_key`, and minus `sms_test_otp` (test phone → OTP
 * pairs, which sign in as those phones).
 */

import { isList, isRecord } from '@vaubaan/plugin-sdk';

/** The fixed marker that replaces a secret value. */
export const REDACTED_VALUE = '[redacted by Vaubaan]';

/** Fields of an edge-function secret entry returned as they are. `value` is not one. */
export const FUNCTION_SECRET_PUBLIC_FIELDS: ReadonlySet<string> = new Set(['name', 'updated_at']);

/** Fields of the project auth config returned as they are ; every other field is redacted. */
export const AUTH_CONFIG_PUBLIC_FIELDS: ReadonlySet<string> = new Set([
  'api_max_request_duration',
  'db_max_pool_size',
  'db_max_pool_size_unit',
  'disable_signup',
  'external_anonymous_users_enabled',
  'external_apple_additional_client_ids',
  'external_apple_client_id',
  'external_apple_email_optional',
  'external_apple_enabled',
  'external_azure_client_id',
  'external_azure_email_optional',
  'external_azure_enabled',
  'external_azure_url',
  'external_bitbucket_client_id',
  'external_bitbucket_email_optional',
  'external_bitbucket_enabled',
  'external_discord_client_id',
  'external_discord_email_optional',
  'external_discord_enabled',
  'external_email_enabled',
  'external_facebook_client_id',
  'external_facebook_email_optional',
  'external_facebook_enabled',
  'external_figma_client_id',
  'external_figma_email_optional',
  'external_figma_enabled',
  'external_github_client_id',
  'external_github_email_optional',
  'external_github_enabled',
  'external_gitlab_client_id',
  'external_gitlab_email_optional',
  'external_gitlab_enabled',
  'external_gitlab_url',
  'external_google_additional_client_ids',
  'external_google_client_id',
  'external_google_email_optional',
  'external_google_enabled',
  'external_google_skip_nonce_check',
  'external_kakao_client_id',
  'external_kakao_email_optional',
  'external_kakao_enabled',
  'external_keycloak_client_id',
  'external_keycloak_email_optional',
  'external_keycloak_enabled',
  'external_keycloak_url',
  'external_linkedin_oidc_client_id',
  'external_linkedin_oidc_email_optional',
  'external_linkedin_oidc_enabled',
  'external_slack_oidc_client_id',
  'external_slack_oidc_email_optional',
  'external_slack_oidc_enabled',
  'external_notion_client_id',
  'external_notion_email_optional',
  'external_notion_enabled',
  'external_phone_enabled',
  'external_slack_client_id',
  'external_slack_email_optional',
  'external_slack_enabled',
  'external_spotify_client_id',
  'external_spotify_email_optional',
  'external_spotify_enabled',
  'external_twitch_client_id',
  'external_twitch_email_optional',
  'external_twitch_enabled',
  'external_twitter_client_id',
  'external_twitter_email_optional',
  'external_twitter_enabled',
  'external_x_client_id',
  'external_x_email_optional',
  'external_x_enabled',
  'external_workos_client_id',
  'external_workos_enabled',
  'external_workos_url',
  'external_web3_solana_enabled',
  'external_web3_ethereum_enabled',
  'external_zoom_client_id',
  'external_zoom_email_optional',
  'external_zoom_enabled',
  'hook_custom_access_token_enabled',
  'hook_custom_access_token_uri',
  'hook_mfa_verification_attempt_enabled',
  'hook_mfa_verification_attempt_uri',
  'hook_password_verification_attempt_enabled',
  'hook_password_verification_attempt_uri',
  'hook_send_sms_enabled',
  'hook_send_sms_uri',
  'hook_send_email_enabled',
  'hook_send_email_uri',
  'hook_before_user_created_enabled',
  'hook_before_user_created_uri',
  'hook_after_user_created_enabled',
  'hook_after_user_created_uri',
  'jwt_exp',
  'mailer_allow_unverified_email_sign_ins',
  'mailer_autoconfirm',
  'mailer_otp_exp',
  'mailer_otp_length',
  'mailer_secure_email_change_enabled',
  'mailer_subjects_confirmation',
  'mailer_subjects_email_change',
  'mailer_subjects_invite',
  'mailer_subjects_magic_link',
  'mailer_subjects_reauthentication',
  'mailer_subjects_recovery',
  'mailer_subjects_password_changed_notification',
  'mailer_subjects_email_changed_notification',
  'mailer_subjects_phone_changed_notification',
  'mailer_subjects_mfa_factor_enrolled_notification',
  'mailer_subjects_mfa_factor_unenrolled_notification',
  'mailer_subjects_identity_linked_notification',
  'mailer_subjects_identity_unlinked_notification',
  'mailer_templates_confirmation_content',
  'mailer_templates_email_change_content',
  'mailer_templates_invite_content',
  'mailer_templates_magic_link_content',
  'mailer_templates_reauthentication_content',
  'mailer_templates_recovery_content',
  'mailer_templates_password_changed_notification_content',
  'mailer_templates_email_changed_notification_content',
  'mailer_templates_phone_changed_notification_content',
  'mailer_templates_mfa_factor_enrolled_notification_content',
  'mailer_templates_mfa_factor_unenrolled_notification_content',
  'mailer_templates_identity_linked_notification_content',
  'mailer_templates_identity_unlinked_notification_content',
  'mailer_notifications_password_changed_enabled',
  'mailer_notifications_email_changed_enabled',
  'mailer_notifications_phone_changed_enabled',
  'mailer_notifications_mfa_factor_enrolled_enabled',
  'mailer_notifications_mfa_factor_unenrolled_enabled',
  'mailer_notifications_identity_linked_enabled',
  'mailer_notifications_identity_unlinked_enabled',
  'mfa_max_enrolled_factors',
  'mfa_totp_enroll_enabled',
  'mfa_totp_verify_enabled',
  'mfa_phone_enroll_enabled',
  'mfa_phone_verify_enabled',
  'mfa_web_authn_enroll_enabled',
  'mfa_web_authn_verify_enabled',
  'passkey_enabled',
  'webauthn_rp_display_name',
  'webauthn_rp_id',
  'webauthn_rp_origins',
  'mfa_phone_otp_length',
  'mfa_phone_template',
  'mfa_phone_max_frequency',
  'nimbus_oauth_client_id',
  'nimbus_oauth_email_optional',
  'password_hibp_enabled',
  'password_min_length',
  'password_required_characters',
  'rate_limit_anonymous_users',
  'rate_limit_email_sent',
  'rate_limit_sms_sent',
  'rate_limit_token_refresh',
  'rate_limit_verify',
  'rate_limit_otp',
  'rate_limit_web3',
  'refresh_token_rotation_enabled',
  'saml_enabled',
  'saml_external_url',
  'saml_allow_encrypted_assertions',
  'security_sb_forwarded_for_enabled',
  'security_captcha_enabled',
  'security_captcha_provider',
  'security_manual_linking_enabled',
  'security_refresh_token_reuse_interval',
  'security_update_password_require_current_password',
  'security_update_password_require_reauthentication',
  'sessions_inactivity_timeout',
  'sessions_single_per_user',
  'sessions_tags',
  'sessions_timebox',
  'site_url',
  'sms_autoconfirm',
  'sms_max_frequency',
  'sms_messagebird_originator',
  'sms_otp_exp',
  'sms_otp_length',
  'sms_provider',
  'sms_template',
  'sms_test_otp_valid_until',
  'sms_textlocal_sender',
  'sms_twilio_account_sid',
  'sms_twilio_content_sid',
  'sms_twilio_message_service_sid',
  'sms_twilio_verify_account_sid',
  'sms_twilio_verify_message_service_sid',
  'sms_vonage_from',
  'smtp_admin_email',
  'smtp_host',
  'smtp_max_frequency',
  'smtp_port',
  'smtp_sender_name',
  'smtp_user',
  'uri_allow_list',
  'oauth_server_enabled',
  'oauth_server_allow_dynamic_registration',
  'oauth_server_authorization_path',
  'custom_oauth_enabled',
  'custom_oauth_max_providers',
]);

/** True when a value says "not set" : nothing to hide. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Keep the allowed fields of one object, replace the value of every other field by the marker. */
export function redactObject(payload: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isRecord(payload)) {
    // Not the documented shape : nothing in it can be shown field by field.
    return isEmpty(payload) ? payload : REDACTED_VALUE;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = allowed.has(key) || isEmpty(value) ? value : REDACTED_VALUE;
  }
  return out;
}

/** `GET /projects/{ref}/secrets` : names and dates, never a value. */
export function redactFunctionSecrets(payload: unknown): unknown {
  if (isEmpty(payload)) return payload;
  if (!isList(payload)) return redactObject(payload, FUNCTION_SECRET_PUBLIC_FIELDS);
  return payload.map((entry) => redactObject(entry, FUNCTION_SECRET_PUBLIC_FIELDS));
}

/** `GET` / `PATCH /projects/{ref}/config/auth` : settings, never a secret. */
export function redactAuthConfig(payload: unknown): unknown {
  return isEmpty(payload) ? payload : redactObject(payload, AUTH_CONFIG_PUBLIC_FIELDS);
}
