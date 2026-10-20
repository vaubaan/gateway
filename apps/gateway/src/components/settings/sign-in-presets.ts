/**
 * The presets of "Add a sign-in provider" (spec §4.2 Settings → Sign-in):
 * Google and Entra ID are OpenID Connect providers whose issuer, claim names
 * and admission rule the form can fill in, and whose registration steps it can
 * spell out. A preset changes nothing on the server: what is saved is a
 * provider of kind `oidc`, as if typed by hand. Pure data, used by the page and
 * the form.
 */
import { GOOGLE_ISSUER } from '@/server/config';

import type { AdmissionChoice } from './SignInProviderForm';

export const SIGN_IN_PRESET_IDS = ['google', 'entra'] as const;
export type SignInPreset = (typeof SIGN_IN_PRESET_IDS)[number];

export function isSignInPreset(raw: string): raw is SignInPreset {
  return (SIGN_IN_PRESET_IDS as readonly string[]).includes(raw);
}

export interface SignInPresetDefinition {
  readonly label: string;
  readonly title: string;
  readonly lede: string;
  /** The provider id the form suggests when it is free. */
  readonly suggestedId: string;
  readonly suggestedName: string;
  /** A fixed issuer (Google), or `null` when the form asks for the tenant instead (Entra). */
  readonly issuer: string | null;
  readonly claims: { readonly sub: string; readonly email: string; readonly groups: string };
  readonly admission: AdmissionChoice;
  /** Where the client is registered, step by step; the redirect address is shown above them. */
  readonly steps: readonly string[];
  /** What to know before choosing the admission rule and the admin rule. */
  readonly notes: readonly string[];
}

export const SIGN_IN_PRESETS: Readonly<Record<SignInPreset, SignInPresetDefinition>> = {
  google: {
    label: 'Google',
    title: 'Add Google sign-in',
    lede: 'Google accounts and Google Workspace, through OpenID Connect. Anyone in the world holds a Google account: the gateway admits your Workspace domain, or invited people only.',
    suggestedId: 'google',
    suggestedName: 'Google',
    issuer: GOOGLE_ISSUER,
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    admission: 'domains',
    steps: [
      'In the Google Cloud Console, open APIs & Services → Credentials of a project of your organisation and create an OAuth client ID of type "Web application".',
      'Add the redirect address shown above under "Authorized redirect URIs".',
      'If the consent screen asks, set it to "Internal" for a Workspace: only your domain’s accounts are then offered the sign-in.',
      'Paste the client ID and the client secret below.',
    ],
    notes: [
      'Google verifies every address it signs in; the gateway admits a verified address only.',
      'Google sends no groups: teams come from the gateway (Settings → Teams), and the admin rule is a list of emails.',
    ],
  },
  entra: {
    label: 'Entra ID',
    title: 'Add Entra ID sign-in',
    lede: 'Your Microsoft Entra ID tenant (Azure AD), through OpenID Connect. A tenant is a company directory: everyone it signs in is admitted unless you restrict to invited people.',
    suggestedId: 'entra',
    suggestedName: 'Entra ID',
    issuer: null,
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    admission: 'everyone',
    steps: [
      'In the Entra admin center, open App registrations and register an application for "Accounts in this organizational directory only"; pick the platform "Web" and enter the redirect address shown above.',
      'Under Certificates & secrets, create a client secret and copy its value (it is shown once).',
      'Under Token configuration, add the groups claim ("Groups assigned to the application") if the admin rule or team ownership should follow Entra groups; add the optional claims "email" and "xms_edov" for an admin rule by email.',
      'Copy the tenant ID (or your tenant domain) and the application (client) ID into the fields below, with the secret.',
    ],
    notes: [
      'Entra sends group object IDs, not names: write the admin rule as entra:<group object id>, and name teams by their ID too.',
      'Entra sends no verified-email signal by default; an admin rule by email is safer with sign_in.<id>.require_verified_email and claims.email_verified: xms_edov in the configuration (handbook authentication).',
    ],
  },
};
