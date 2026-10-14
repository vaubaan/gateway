/**
 * Creating the company's app from Administration → Company apps, through the
 * provider's app manifest (spec §4.2 "company apps", §6; ADR
 * company-app-created-from-a-manifest). Handbook: docs/handbook/connections.md
 * ("Company apps created from the page").
 *
 *   start     the administrator's choice (owner, name, permissions) is
 *             checked against the plugin's declaration; the manifest is built
 *             on `public_url`; a `state` is drawn and stored with it, bound to
 *             the administrator's web session, for `REGISTRATION_TTL_MS`.
 *   pending   the page that posts the manifest to the provider reads it back
 *             (same session only), without consuming it.
 *   complete  the provider's redirect: the state is taken (once, same session),
 *             the code exchanged server to server, the app's settings stored
 *             where the manual form stores them (secrets sealed), what the page
 *             shows of the app kept beside them, and one `config-changed` audit
 *             entry written — never a secret.
 *
 * The flow is refused when the mounted configuration sets the provider's app
 * (read-only) and when an app is already stored: replacing one is the form's
 * job. Both are checked at the start and again at the return.
 *
 * Nothing here names a provider: what the flow needs comes from the plugin's
 * `credential.manifestRegistration`.
 */
import { randomBytes } from 'node:crypto';

import type { AuditWriter } from '@vaubaan/gateway-core';
import {
  checkPermissionChoice,
  defaultPermissionChoice,
  type AppManifestRegistration,
  type AppOwner,
  type PluginRegistry,
} from '@vaubaan/plugin-sdk';

import type { SessionStore } from '../compose/ports';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import { ProviderAppError, type AppRegistrationRecord, type ProviderAppsService } from './service';

const MINUTE_MS = 60_000;
/**
 * How long the administrator has to confirm at the provider and come back.
 * Shorter than the provider's own limit on the code (one hour at GitHub).
 */
export const REGISTRATION_TTL_MS = 15 * MINUTE_MS;
const STATE_BYTES = 32;
const STATE_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
/** The provider's answer to the code exchange is read up to this size. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** The path the provider sends the browser back to, per provider. */
export function registrationReturnPath(providerId: string): string {
  return `/admin/provider-apps/${encodeURIComponent(providerId)}/created`;
}

export const REGISTRATION_ERROR_CODES = [
  'not-supported',
  'read-only',
  'already-set',
  'invalid-choice',
  'state-invalid',
  'cancelled',
  'code-invalid',
  'exchange-refused',
  'exchange-failed',
  'answer-unreadable',
] as const;
export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODES)[number];

/** Why the flow stopped; `problems` are the plain sentences shown to the administrator. */
export class AppRegistrationError extends Error {
  constructor(
    readonly code: RegistrationErrorCode,
    readonly problems: readonly string[],
  ) {
    super(problems.join('; '));
    this.name = 'AppRegistrationError';
  }
}

/** Who is creating the app: the web session and the audit actor. */
export interface RegistrationActor {
  readonly sessionId: string;
  readonly actorId: string;
}

/** What the administrator chose on the page (raw form values). */
export interface RegistrationChoice {
  readonly ownerKind: string;
  readonly ownerLogin: string;
  readonly name: string;
  /** Permission name → level or `none`. */
  readonly permissions: Readonly<Record<string, string>>;
}

/** What the page that posts to the provider needs. */
export interface PendingRegistrationView {
  readonly providerId: string;
  /** The form's action: the provider's registration address with the state. */
  readonly action: string;
  readonly manifestField: string;
  /** The manifest as JSON, the value of `manifestField`. */
  readonly manifest: string;
  readonly owner: AppOwner;
  readonly name: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

interface PendingRegistration {
  readonly providerId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly owner: AppOwner;
  readonly name: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly manifest: string;
  readonly createdAt: string;
}

export interface AppRegistrationDeps {
  readonly registry: PluginRegistry;
  readonly providerApps: ProviderAppsService;
  readonly sessions: SessionStore;
  readonly publicUrl: URL;
  /** The connection callback of a provider: the manifest's callback address. */
  readonly callbackUrl: (providerId: string) => URL;
  readonly audit: AuditWriter;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class AppRegistrationService {
  // single-process only — makes `take` atomic inside one process (the port has no
  // get-and-delete), like `PendingConnectStore`. A hosted `SessionStore` needs GETDEL.
  private readonly taking = new Set<string>();

  constructor(private readonly deps: AppRegistrationDeps) {}

  /** The provider's manifest declaration, or `null` when its app is entered by hand only. */
  manifestOf(providerId: string): AppManifestRegistration | null {
    if (!this.deps.registry.has(providerId)) return null;
    const spec = this.deps.registry.require(providerId).plugin.credential;
    return spec.kind === 'app-install' ? (spec.manifestRegistration ?? null) : null;
  }

  /** A name unique enough to tell this instance's app from another's: "Vaubaan <host>". */
  defaultName(providerId: string): string {
    const max = this.manifestOf(providerId)?.nameMaxLength ?? Number.POSITIVE_INFINITY;
    return `Vaubaan ${this.deps.publicUrl.host}`.slice(0, max).trim();
  }

  /** Whether the page may offer the flow now, and why not. */
  async availability(providerId: string): Promise<RegistrationErrorCode | null> {
    if (!this.manifestOf(providerId)) return 'not-supported';
    if (this.deps.providerApps.isReadOnly(providerId)) return 'read-only';
    const status = await this.deps.providerApps.status(providerId);
    return status.source === 'none' ? null : 'already-set';
  }

  async start(
    actor: RegistrationActor,
    providerId: string,
    choice: RegistrationChoice,
  ): Promise<{ readonly state: string }> {
    const manifest = await this.requireAvailable(providerId);
    const owner = ownerOf(manifest, choice);
    const name = choice.name.trim();
    const problems: string[] = [];
    if ('problem' in owner) problems.push(owner.problem);
    if (name.length === 0) problems.push('The name is required.');
    else if (name.length > manifest.nameMaxLength) {
      problems.push(`The name is longer than ${manifest.nameMaxLength} characters.`);
    }
    const permissions = checkPermissionChoice(manifest.permissions, choice.permissions);
    if (!permissions.ok) problems.push(...permissions.problems);
    if (problems.length > 0 || 'problem' in owner || !permissions.ok) {
      throw new AppRegistrationError('invalid-choice', problems);
    }
    const body = manifest.buildManifest({
      name,
      homepageUrl: this.deps.publicUrl.href,
      callbackUrl: this.deps.callbackUrl(providerId).href,
      redirectUrl: new URL(registrationReturnPath(providerId), this.deps.publicUrl).href,
      permissions: permissions.permissions,
    });
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const pending: PendingRegistration = {
      providerId,
      sessionId: actor.sessionId,
      actorId: actor.actorId,
      owner,
      name,
      permissions: permissions.permissions,
      manifest: JSON.stringify(body),
      createdAt: toIso(this.deps.clock.now()),
    };
    await this.deps.sessions.set(key(state), pending, REGISTRATION_TTL_MS);
    this.deps.logger.info('company app: creation started', {
      provider: providerId,
      owner: owner.kind === 'organization' ? owner.login : 'personal account',
    });
    return { state };
  }

  /** The flow in flight for this state, read back by the session that started it. */
  async pending(
    sessionId: string,
    providerId: string,
    state: string | null,
  ): Promise<PendingRegistrationView | null> {
    if (!state || !STATE_PATTERN.test(state)) return null;
    const record = (await this.deps.sessions.get(key(state))) as PendingRegistration | null;
    if (!record || record.sessionId !== sessionId || record.providerId !== providerId) return null;
    const manifest = this.manifestOf(providerId);
    if (!manifest) return null;
    const action = new URL(manifest.registrationUrl(record.owner));
    action.searchParams.set(manifest.stateParam, state);
    return {
      providerId,
      action: action.href,
      manifestField: manifest.manifestField,
      manifest: record.manifest,
      owner: record.owner,
      name: record.name,
      permissions: record.permissions,
      expiresAt: toIso(new Date(Date.parse(record.createdAt) + REGISTRATION_TTL_MS)),
    };
  }

  /** The provider's redirect: one exchange, one save, one audit entry. */
  async complete(
    sessionId: string,
    providerId: string,
    query: URLSearchParams,
  ): Promise<AppRegistrationRecord> {
    const manifest = this.manifestOf(providerId);
    if (!manifest) throw refusal('not-supported');
    const pending = await this.take(query.get(manifest.stateParam), sessionId, providerId);
    const code = query.get(manifest.codeParam);
    if (code === null || code.length === 0) throw refusal('cancelled');
    const url = manifest.conversionUrl(code);
    if (url === null) throw refusal('code-invalid');
    // Checked again: an app may have been entered by hand in the meantime.
    await this.requireAvailable(providerId);

    const app = await this.exchange(manifest, url);
    const before = await this.deps.providerApps.status(providerId);
    const now = toIso(this.deps.clock.now());
    let after;
    try {
      after = await this.deps.providerApps.saveRegistered(providerId, app.appConfig, {
        name: app.name,
        slug: app.slug,
        ownerLogin: app.ownerLogin,
        ownerKind: pending.owner.kind,
        htmlUrl: app.htmlUrl,
        permissions: app.permissions,
        createdBy: pending.actorId,
        createdAt: now,
      });
    } catch (err) {
      if (err instanceof ProviderAppError) {
        // The provider answered something the form would not accept: say so, store nothing.
        this.deps.logger.error('company app: the created app was not stored', {
          provider: providerId,
          problems: err.problems,
        });
        throw new AppRegistrationError('answer-unreadable', [
          ...err.problems,
          'The app exists at the service but this gateway did not store it; delete it there and start again.',
        ]);
      }
      throw err;
    }
    const record = await this.deps.providerApps.registration(providerId);
    if (!record) throw refusal('answer-unreadable');
    await this.auditCreated(pending, providerId, before, after, record);
    this.deps.logger.info('company app: created and stored', {
      provider: providerId,
      app: app.slug,
      owner: app.ownerLogin,
    });
    return record;
  }

  private async requireAvailable(providerId: string): Promise<AppManifestRegistration> {
    const why = await this.availability(providerId);
    const manifest = this.manifestOf(providerId);
    if (why !== null || !manifest) throw refusal(why ?? 'not-supported');
    return manifest;
  }

  /** Single use: the record is deleted whether or not the caller is its owner. */
  private async take(
    state: string | null,
    sessionId: string,
    providerId: string,
  ): Promise<PendingRegistration> {
    if (!state || !STATE_PATTERN.test(state) || this.taking.has(state)) {
      throw refusal('state-invalid');
    }
    this.taking.add(state);
    try {
      const record = (await this.deps.sessions.get(key(state))) as PendingRegistration | null;
      if (!record) throw refusal('state-invalid');
      await this.deps.sessions.delete(key(state));
      if (record.sessionId !== sessionId || record.providerId !== providerId) {
        this.deps.logger.warn('company app: a return arrived in another session', {
          provider: providerId,
        });
        throw refusal('state-invalid');
      }
      return record;
    } finally {
      this.taking.delete(state);
    }
  }

  private async exchange(manifest: AppManifestRegistration, url: string) {
    let res: Response;
    try {
      res = await this.deps.fetch(url, {
        method: 'POST',
        headers: { ...(manifest.conversionHeaders ?? {}) },
        redirect: 'error',
      });
    } catch (err) {
      this.deps.logger.error('company app: the code exchange did not reach the service', {
        detail: err instanceof Error ? err.message : String(err),
      });
      throw refusal('exchange-failed');
    }
    if (!res.ok) {
      // The body may echo nothing secret, but it is not ours to log: the status says enough.
      this.deps.logger.warn('company app: the service refused the code exchange', {
        status: res.status,
      });
      throw refusal('exchange-refused', `The service answered ${res.status}.`);
    }
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw refusal('answer-unreadable');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw refusal('answer-unreadable');
    }
    const app = manifest.registeredApp(body);
    if (!app) throw refusal('answer-unreadable');
    return app;
  }

  /** `config-changed` on the provider's app: who, which app, what it requested. Never a secret. */
  private async auditCreated(
    pending: PendingRegistration,
    providerId: string,
    before: Awaited<ReturnType<ProviderAppsService['status']>>,
    after: Awaited<ReturnType<ProviderAppsService['status']>>,
    record: AppRegistrationRecord,
  ): Promise<void> {
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: pending.actorId,
        act: 'config-changed',
        object: { type: 'instance-config', id: `provider-app:${providerId}` },
        // The shape of a form save (`values` are the non-secret fields: the
        // app id, its slug, its client id), plus what was created and asked.
        before: { source: before.source, values: before.values, secrets_set: before.secretsSet },
        after: {
          source: after.source,
          values: after.values,
          secrets_set: after.secretsSet,
          created_from: 'manifest',
          app_name: record.name,
          app_slug: record.slug,
          owner: record.ownerLogin,
          owner_kind: record.ownerKind,
          permissions_requested: { ...pending.permissions },
        },
        delegated_client_id: null,
      });
    } catch (err) {
      this.deps.logger.error('audit entry not written for a created company app', {
        provider: providerId,
        err,
      });
    }
  }
}

function key(state: string): string {
  return `app-registration:${state}`;
}

const MESSAGES: Record<RegistrationErrorCode, string> = {
  'not-supported': 'This service’s app is entered by hand: there is no way to create it from here.',
  'read-only':
    'This service’s app is set in the mounted configuration; change it there and restart.',
  'already-set':
    'A company app is already set for this service. To replace it, edit it from its form.',
  'invalid-choice': 'Some of what you chose cannot be sent.',
  'state-invalid':
    'This return does not match a creation started in this session, or it took too long. Nothing was stored; start again.',
  cancelled: 'The app was not created: the service sent no confirmation. Nothing was stored.',
  'code-invalid': 'The service sent back a code this gateway cannot use. Nothing was stored.',
  'exchange-refused':
    'The service refused to hand over the app’s settings — the confirmation may have expired or been used already. If the app was created, delete it at the service and start again.',
  'exchange-failed':
    'The service could not be reached to fetch the app’s settings. If the app was created, delete it at the service and start again.',
  'answer-unreadable':
    'The service answered without what this gateway needs. Nothing was stored; if the app was created, delete it at the service and start again.',
};

function refusal(code: RegistrationErrorCode, detail?: string): AppRegistrationError {
  return new AppRegistrationError(code, detail ? [MESSAGES[code], detail] : [MESSAGES[code]]);
}

/** The plain sentence of a code, for a page that explains why the flow is not offered. */
export function registrationMessage(code: RegistrationErrorCode): string {
  return MESSAGES[code];
}

function ownerOf(
  manifest: AppManifestRegistration,
  choice: RegistrationChoice,
): AppOwner | { readonly problem: string } {
  if (choice.ownerKind === 'personal') return { kind: 'personal' };
  if (choice.ownerKind !== 'organization') return { problem: 'Choose who owns the app.' };
  const login = choice.ownerLogin.trim();
  if (login.length === 0) return { problem: 'The organisation’s name is required.' };
  if (!new RegExp(manifest.ownerLoginPattern).test(login)) {
    return { problem: `“${login.slice(0, 60)}” is not an organisation name the service accepts.` };
  }
  return { kind: 'organization', login };
}

/** Re-exported for the page: the default choice of a provider's declaration. */
export { defaultPermissionChoice };
