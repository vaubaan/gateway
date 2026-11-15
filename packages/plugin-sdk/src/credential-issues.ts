/**
 * The checks `definePlugin` runs on a `CredentialSpec` : the closed set of
 * kinds and their fields, the one client source of an `oauth2` spec, and the
 * token guide an `api-key` way carries (ADR
 * one-place-to-authorize-services-token-first, amended 2026-10-31 : the guide
 * and the check at paste are part of the plugin contract).
 */

import { CREDENTIAL_KINDS, isCredentialKind } from '@vaubaan/shared';

import {
  BROKER_PROVIDER_PATTERN,
  CREDENTIAL_ALTERNATIVE_ID_PATTERN,
  CREDENTIAL_ALTERNATIVES_MAX,
  type CredentialField,
  GUIDE_PATH_MAX_SEGMENTS,
  GUIDE_PATH_SEGMENT_MAX_LENGTH,
  GUIDE_SCREENSHOT_FILE_PATTERN,
  OAUTH2_REVOCATION_FORMATS,
  SCREENSHOT_ALT_MAX_LENGTH,
  SCREENSHOT_LICENCES,
  SCREENSHOT_TAKEN_PATTERN,
  TOKEN_EXPIRY_KINDS,
  TOKEN_PERMISSION_ACCESS,
  type CredentialSpec,
  type OAuth2CredentialSpec,
  type OAuth2RegisteredClientSpec,
} from './credential.ts';
import { isList, isRecord } from './guards.ts';

/** Upper bound of one guide sentence: a step, a command, a reach line, a reason. */
export const CREDENTIAL_SENTENCE_MAX_LENGTH = 300;

/**
 * Every issue of a plugin's `CredentialSpec`. `tools` are the tool names the
 * plugin answers for, its git remote's included (`declaredToolNames`) : the
 * permissions of a token guide must serve each of them.
 */
export function credentialSpecIssues(spec: CredentialSpec, tools: ReadonlySet<unknown>): string[] {
  const at = 'credential';
  const issues = kindSpecIssues(spec);
  if (!isRecord(spec) || typeof spec.kind !== 'string') return issues;
  // The instructions are part of the contract (ADR
  // one-place-to-authorize-services-token-first, amended 2026-10-31).
  if (spec.kind === 'api-key') {
    if (!isSentence(spec.label, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${at}.label: expected what the person creates, in the service's words`);
    }
    if (typeof spec.verify !== 'function') {
      issues.push(`${at}.verify: expected the check at paste, a function`);
    }
    if (!isHttpsUrl(spec.createUrl)) {
      issues.push(`${at}.createUrl: expected the https URL of the token page`);
    }
    issues.push(...guideIssues(spec.guide, tools, `${at}.guide`));
    if (spec.alternatives !== undefined) {
      issues.push(...alternativesIssues(spec.alternatives, spec.fields, `${at}.alternatives`));
    }
    issues.push(...screenshotsIssues(spec.guide, spec.alternatives, `${at}.guide.screenshots`));
  }
  return issues;
}

/**
 * The screenshots of a guide (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-13): each declared with a source, a licence of the
 * allowlist, the month it was taken and an alt text, and named by exactly
 * one step, the alternatives' steps included; every step's screenshot is
 * declared. Whether the file exists, its format, weight and width are the
 * host's structural test: the declaration is all `definePlugin` sees.
 */
function screenshotsIssues(guide: unknown, alternatives: unknown, at: string): string[] {
  if (!isRecord(guide)) return [];
  const steps = [
    ...(isList(alternatives)
      ? alternatives.flatMap((alt) => (isRecord(alt) && isList(alt.steps) ? alt.steps : []))
      : []),
    ...(isList(guide.steps) ? guide.steps : []),
  ];
  const named = new Map<string, number>();
  for (const step of steps) {
    if (isRecord(step) && typeof step.screenshot === 'string') {
      named.set(step.screenshot, (named.get(step.screenshot) ?? 0) + 1);
    }
  }
  const declared = guide.screenshots;
  if (declared === undefined) {
    return [...named.keys()].map((file) => `${at}: '${file}' is named by a step but not declared`);
  }
  if (!isRecord(declared)) return [`${at}: expected { '<file>': { source, licence, taken, alt } }`];
  const issues: string[] = [];
  for (const [file, shot] of Object.entries(declared)) {
    const where = `${at}['${file}']`;
    if (!GUIDE_SCREENSHOT_FILE_PATTERN.test(file)) {
      issues.push(`${where}: expected a file name such as 'token-form.webp' (.png or .webp)`);
    }
    issues.push(...screenshotIssues(shot, where));
    const uses = named.get(file) ?? 0;
    if (uses === 0) issues.push(`${where}: declared but named by no step`);
    if (uses > 1) issues.push(`${where}: named by ${uses} steps, expected one`);
  }
  for (const file of named.keys()) {
    if (!Object.hasOwn(declared, file)) {
      issues.push(`${at}: '${file}' is named by a step but not declared`);
    }
  }
  return issues;
}

function screenshotIssues(shot: unknown, at: string): string[] {
  if (!isRecord(shot)) return [`${at}: expected { source, licence, taken, alt }`];
  const issues: string[] = [];
  if (shot.source !== 'ours' && !isHttpsUrl(shot.source)) {
    issues.push(`${at}.source: expected the https URL of the page it was taken from, or 'ours'`);
  }
  if (!(SCREENSHOT_LICENCES as readonly unknown[]).includes(shot.licence)) {
    issues.push(
      `${at}.licence: expected one of ${SCREENSHOT_LICENCES.join(' | ')} (a licence that forbids commercial use or changes never ships)`,
    );
  } else if ((shot.source === 'ours') !== (shot.licence === 'ours')) {
    issues.push(`${at}.licence: 'ours' goes with the source 'ours', and only with it`);
  }
  if (typeof shot.taken !== 'string' || !SCREENSHOT_TAKEN_PATTERN.test(shot.taken)) {
    issues.push(`${at}.taken: expected the month it was taken, YYYY-MM`);
  }
  if (!isSentence(shot.alt, SCREENSHOT_ALT_MAX_LENGTH)) {
    issues.push(
      `${at}.alt: expected what the image shows, 1 to ${SCREENSHOT_ALT_MAX_LENGTH} characters`,
    );
  }
  return issues;
}

/** A path is the service's menu labels, in order: 1 to 8 segments, none empty, none long. */
function pathIssues(path: unknown, at: string): string[] {
  if (!isList(path) || path.length === 0 || path.length > GUIDE_PATH_MAX_SEGMENTS) {
    return [`${at}: expected 1 to ${GUIDE_PATH_MAX_SEGMENTS} menu labels when present`];
  }
  return path.flatMap((segment, i) =>
    isSentence(segment, GUIDE_PATH_SEGMENT_MAX_LENGTH)
      ? []
      : [`${at}[${i}]: expected a menu label of 1 to ${GUIDE_PATH_SEGMENT_MAX_LENGTH} characters`],
  );
}

/**
 * Alternatives are a real choice (two or more, a handful at most), each with
 * a unique slug, a label, its own steps and fields of its own that the spec
 * declares; together with the shared fields, each asks for a secret.
 */
function alternativesIssues(
  alternatives: unknown,
  fields: readonly CredentialField[],
  at: string,
): string[] {
  if (
    !isList(alternatives) ||
    alternatives.length < 2 ||
    alternatives.length > CREDENTIAL_ALTERNATIVES_MAX
  ) {
    return [`${at}: expected 2 to ${CREDENTIAL_ALTERNATIVES_MAX} alternatives`];
  }
  const declared = new Map(fields.map((f) => [f.name, f]));
  const owner = new Map<string, number>();
  const ids = new Set<unknown>();
  const issues: string[] = [];
  alternatives.forEach((alt, i) => {
    const where = `${at}[${i}]`;
    if (!isRecord(alt)) {
      issues.push(`${where}: expected { id, label, fields, steps }`);
      return;
    }
    if (typeof alt.id !== 'string' || !CREDENTIAL_ALTERNATIVE_ID_PATTERN.test(alt.id)) {
      issues.push(`${where}.id: expected a lowercase slug such as 'team'`);
    } else if (ids.has(alt.id)) {
      issues.push(`${where}.id: '${alt.id}' is already the id of another alternative`);
    }
    ids.add(alt.id);
    if (!isSentence(alt.label, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${where}.label: expected a few words`);
    }
    if (alt.help !== undefined && !isSentence(alt.help, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${where}.help: expected one sentence when present`);
    }
    issues.push(...stepIssues(alt.steps, `${where}.steps`));
    if (!isList(alt.fields) || alt.fields.length === 0) {
      issues.push(`${where}.fields: expected at least one field of its own`);
      return;
    }
    for (const name of alt.fields) {
      if (typeof name !== 'string' || !declared.has(name)) {
        issues.push(`${where}.fields: '${String(name)}' is not a field of this spec`);
      } else if (owner.has(name)) {
        issues.push(`${where}.fields: '${name}' already belongs to another alternative`);
      } else {
        owner.set(name, i);
      }
    }
  });
  alternatives.forEach((alt, i) => {
    if (!isRecord(alt)) return;
    const asked = fields.filter((f) => !owner.has(f.name) || owner.get(f.name) === i);
    if (!asked.some((f) => f.secret)) {
      issues.push(`${at}[${i}]: asks for no secret field`);
    }
  });
  return issues;
}

/**
 * A guide says where to click (`steps`), how wide to grant (`reach`), when the
 * token stops working (`expiry`) and where the service documents it; its
 * permissions name real tools, in the closed access set, and cover every tool
 * this way of connecting can run: the page derives the permissions to grant
 * from it, so a tool nobody asked a permission for would fail at the service.
 */
function guideIssues(guide: unknown, tools: ReadonlySet<unknown>, at: string): string[] {
  if (!isRecord(guide)) {
    return [`${at}: expected { steps, reach, permissions, expiry, docsUrl }`];
  }
  return [
    ...stepIssues(guide.steps, `${at}.steps`),
    ...reachIssues(guide.reach, `${at}.reach`),
    ...expiryIssues(guide.expiry, `${at}.expiry`),
    ...(isHttpsUrl(guide.docsUrl) ? [] : [`${at}.docsUrl: expected an https URL`]),
    ...permissionIssues(guide.permissions, tools, `${at}.permissions`),
  ];
}

/**
 * Every step is one sentence to act on, with the service's menu path, an
 * https page, a command to copy and a screenshot's file name when it has them.
 */
function stepIssues(steps: unknown, at: string): string[] {
  if (!isList(steps) || steps.length === 0) return [`${at}: expected at least one step`];
  const issues: string[] = [];
  steps.forEach((step, i) => {
    const where = `${at}[${i}]`;
    if (!isRecord(step)) {
      issues.push(`${where}: expected { do, path?, url?, code?, screenshot? }`);
      return;
    }
    if (!isSentence(step.do, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${where}.do: expected one plain sentence`);
    }
    if (step.url !== undefined && !isHttpsUrl(step.url)) {
      issues.push(`${where}.url: expected an https URL when present`);
    }
    if (step.code !== undefined && !isSentence(step.code, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${where}.code: expected a non-empty command when present`);
    }
    if (step.path !== undefined) issues.push(...pathIssues(step.path, `${where}.path`));
    if (
      step.screenshot !== undefined &&
      (typeof step.screenshot !== 'string' || !GUIDE_SCREENSHOT_FILE_PATTERN.test(step.screenshot))
    ) {
      issues.push(`${where}.screenshot: expected a file name such as 'token-form.webp'`);
    }
  });
  return issues;
}

function reachIssues(reach: unknown, at: string): string[] {
  if (!isRecord(reach)) return [`${at}: expected { what, grant, why }`];
  return (['what', 'grant', 'why'] as const)
    .filter((key) => !isSentence(reach[key], CREDENTIAL_SENTENCE_MAX_LENGTH))
    .map((key) => `${at}.${key}: expected one plain sentence`);
}

function expiryIssues(expiry: unknown, at: string): string[] {
  if (!isRecord(expiry) || !(TOKEN_EXPIRY_KINDS as readonly unknown[]).includes(expiry.kind)) {
    return [`${at}.kind: expected one of ${TOKEN_EXPIRY_KINDS.join(' | ')}`];
  }
  if (expiry.kind === 'person-types') {
    const days = expiry.recommendedDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      return [`${at}.recommendedDays: expected a positive number of days`];
    }
  }
  if (expiry.kind === 'none' && !isSentence(expiry.reason, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
    return [`${at}.reason: expected one sentence saying how the token is ended`];
  }
  return [];
}

function permissionIssues(permissions: unknown, tools: ReadonlySet<unknown>, at: string): string[] {
  if (!isList(permissions)) {
    return [`${at}: expected a list (empty when the token carries no choice)`];
  }
  // A service whose tokens carry no permission choice (Railway) lists none.
  if (permissions.length === 0) return [];
  const issues: string[] = [];
  const served = new Set<unknown>();
  permissions.forEach((permission, i) => {
    const where = `${at}[${i}]`;
    if (!isRecord(permission)) {
      issues.push(`${where}: expected { name, access, tools }`);
      return;
    }
    if (!isName(permission.name)) issues.push(`${where}.name: expected the service's name`);
    if (!(TOKEN_PERMISSION_ACCESS as readonly unknown[]).includes(permission.access)) {
      issues.push(`${where}.access: expected one of ${TOKEN_PERMISSION_ACCESS.join(' | ')}`);
    }
    if (!isList(permission.tools) || permission.tools.length === 0) {
      issues.push(`${where}.tools: expected at least one tool`);
      return;
    }
    for (const tool of permission.tools) {
      if (!tools.has(tool))
        issues.push(`${where}.tools: '${String(tool)}' is not a tool of this plugin`);
      served.add(tool);
    }
  });
  for (const tool of tools) {
    if (typeof tool === 'string' && !served.has(tool)) {
      issues.push(`${at}: no permission serves '${tool}'`);
    }
  }
  return issues;
}

export function isSentence(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.trim().length > 0 && x.length <= max;
}

function kindSpecIssues(spec: CredentialSpec): string[] {
  if (!spec || typeof spec !== 'object') return ['credential: missing CredentialSpec'];
  if (typeof spec.kind !== 'string' || !isCredentialKind(spec.kind)) {
    return [`credential.kind: expected one of ${CREDENTIAL_KINDS.join(' | ')}`];
  }
  const issues: string[] = [];
  switch (spec.kind) {
    case 'api-key':
      if (!isList(spec.fields) || spec.fields.length === 0)
        issues.push('credential.fields: expected at least one field');
      else if (!spec.fields.some((f) => f.secret))
        issues.push('credential.fields: an api-key spec needs at least one secret field');
      break;
    case 'oauth2':
      issues.push(...oauth2Issues(spec));
      break;
    case 'ssh-key':
      if (spec.algorithm !== 'ed25519')
        issues.push("credential.algorithm: only 'ed25519' is supported");
      if (!Array.isArray(spec.fields))
        issues.push('credential.fields: expected a list (host, port, user)');
      break;
    case 'host': {
      // Nothing to ask, nothing to check: a field would be a secret the host never holds.
      const extra = Object.keys(spec).filter((key) => key !== 'kind');
      if (extra.length > 0) {
        issues.push(
          `credential: a host account declares nothing but its kind (${extra.join(', ')})`,
        );
      }
      break;
    }
  }
  return issues;
}

/**
 * Fields only a spec with a registered client carries: a brokered spec leaves
 * the service's endpoints, PKCE, the client authentication and the
 * revocation to the broker.
 */
const REGISTERED_CLIENT_ONLY_FIELDS = [
  'authorizationUrl',
  'tokenUrl',
  'pkce',
  'resourceIndicator',
  'clientAuthMethod',
  'refreshable',
  'extraAuthorizationParams',
  'revocation',
] as const;

/**
 * An `oauth2` spec declares exactly one client source (ADR
 * google-calendar-through-an-oauth-broker D3): `clientRegistration` (the gateway
 * registers itself) or `broker` (the client is an OAuth broker's).
 */
function oauth2Issues(spec: OAuth2CredentialSpec): string[] {
  const record = spec as unknown as Record<string, unknown>;
  const hasBroker = record.broker !== undefined;
  const hasRegistration = record.clientRegistration !== undefined;
  if (hasBroker && hasRegistration) {
    return ['credential: declare one client source, clientRegistration or broker, not both'];
  }
  const issues: string[] = [];
  if (!Array.isArray(spec.scopes)) issues.push('credential.scopes: expected a list (may be empty)');
  if (hasBroker) {
    const broker: unknown = record.broker;
    if (
      !isRecord(broker) ||
      typeof broker.provider !== 'string' ||
      !BROKER_PROVIDER_PATTERN.test(broker.provider)
    ) {
      issues.push(
        "credential.broker: expected { provider } with a lowercase slug such as 'google'",
      );
    }
    for (const field of REGISTERED_CLIENT_ONLY_FIELDS) {
      if (record[field] !== undefined) {
        issues.push(`credential.${field}: a brokered spec leaves it to the broker`);
      }
    }
    return issues;
  }
  return [...issues, ...registeredClientIssues(spec as OAuth2RegisteredClientSpec)];
}

function registeredClientIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const issues: string[] = [];
  for (const key of ['authorizationUrl', 'tokenUrl'] as const) {
    if (!isHttpsUrl(spec[key])) issues.push(`credential.${key}: expected an https URL`);
  }
  if (spec.clientAuthMethod === 'none' && !spec.pkce)
    issues.push('credential.pkce: a public client (clientAuthMethod none) must use PKCE');
  if (spec.revocation !== undefined) issues.push(...revocationIssues(spec));
  // Without a broker, the only OAuth client the host knows is one it registers
  // itself (ADR gmail-over-imap-with-an-app-password): no administrator declares one.
  issues.push(...registrationIssues(spec));
  // `refreshable: true` needs no `refresh()` : the host performs the standard
  // refresh_token grant from the spec (ADR plugin-contract D2 as amended) ;
  // `refresh` is an override for non-standard flows.
  return issues;
}

function isName(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

export function isHttpsUrl(x: unknown): boolean {
  if (typeof x !== 'string') return false;
  try {
    return new URL(x).protocol === 'https:';
  } catch {
    return false;
  }
}

function registrationIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const registration: unknown = spec.clientRegistration;
  if (!isRecord(registration))
    return ['credential.clientRegistration: expected { registrationUrl }'];
  const issues: string[] = [];
  if (!isHttpsUrl(registration.registrationUrl)) {
    issues.push('credential.clientRegistration.registrationUrl: expected an https URL');
  }
  return issues;
}

function revocationIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const revocation: unknown = spec.revocation;
  if (!isRecord(revocation)) return ['credential.revocation: expected { url, format }'];
  const issues: string[] = [];
  if (!isHttpsUrl(revocation.url)) issues.push('credential.revocation.url: expected an https URL');
  if (!(OAUTH2_REVOCATION_FORMATS as readonly unknown[]).includes(revocation.format)) {
    issues.push(
      `credential.revocation.format: expected one of ${OAUTH2_REVOCATION_FORMATS.join(' | ')}`,
    );
  }
  if (
    revocation.format === 'client-credentials-json' &&
    (spec.clientAuthMethod === 'none' || !spec.refreshable)
  ) {
    issues.push(
      "credential.revocation.format: 'client-credentials-json' needs a confidential client and refresh tokens",
    );
  }
  return issues;
}
