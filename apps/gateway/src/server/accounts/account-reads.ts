/**
 * What the pages read of the accounts: the services a person can connect (with their
 * token guide), the accounts they own, one account in detail, the ownerless ones the
 * operator sees, and what the plugin of an account says about withdrawing its grant.
 * Nothing here writes. The account service delegates these reads here and lends
 * ownership (`AccountReadsHost`).
 */
import {
  type GuideStep,
  isBrokeredSpec,
  type ServicePlugin,
  screenshotAttribution,
  type TokenGuide,
  serviceIconOf,
} from '@vaubaan/plugin-sdk';

import { connectFileUrl } from '../plugins/connect-files';
import { catalogEnvsOf } from '../../lib/missions/catalog-view';
import { resourceNounOf } from '../../lib/services/resource-noun';
import type { AccountRecord } from '../store/types';
import type {
  AccountDetail,
  AccountServiceDeps,
  AccountView,
  Actor,
  ConnectableService,
  DiscoveryAfterCallCause,
  DiscoveryRecord,
  GuideStepView,
  ServiceGrantView,
} from './account-views';
import { canWithdraw } from './credentials';
import { INSTALLED_BROKER } from './installed-broker';
import {
  accountCredentialKind,
  accountOwnerOf,
  accountPublicFields,
  isRetiredWay,
} from './mapping';
import { brokerNotConfiguredReason } from './oauth-broker';
import { tokenLacks } from './token-permissions';

/** What the reads take from the account service: an account the actor owns. */
export interface AccountReadsHost {
  requireOwned(actor: Actor, accountId: string): Promise<AccountRecord>;
}

export class AccountReads {
  constructor(
    private readonly deps: AccountServiceDeps,
    private readonly host: AccountReadsHost,
  ) {}

  // ── Services ─────────────────────────────────────────────────────────────

  /** Every registered plugin, in registry order. */
  async services(): Promise<ConnectableService[]> {
    return Promise.all(this.deps.registry.ids.map((id) => this.describe(id)));
  }

  async service(serviceId: string): Promise<ConnectableService | null> {
    return this.deps.registry.has(serviceId) ? this.describe(serviceId) : null;
  }

  private async describe(serviceId: string): Promise<ConnectableService> {
    const { plugin } = this.deps.registry.require(serviceId);
    const spec = plugin.credential;
    const guide = spec.kind === 'api-key' ? spec.guide : undefined;
    const steps = (list: readonly GuideStep[]): GuideStepView[] =>
      list.map((step) => stepView(plugin, guide?.screenshots, step));
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description ?? null,
      icon: serviceIconOf(plugin),
      resource_noun: resourceNounOf(plugin),
      kind: spec.kind,
      redirects: spec.kind === 'oauth2',
      viaBroker: spec.kind === 'oauth2' && isBrokeredSpec(spec),
      brokerAttested:
        spec.kind === 'oauth2' && isBrokeredSpec(spec)
          ? (this.deps.brokers.forProvider(spec.broker.provider)?.attested ?? null)
          : null,
      viaInstalledClient:
        spec.kind === 'oauth2' &&
        isBrokeredSpec(spec) &&
        this.deps.brokers.forProvider(spec.broker.provider)?.name === INSTALLED_BROKER,
      fields: spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [],
      alternatives:
        spec.kind === 'api-key'
          ? (spec.alternatives ?? []).map((alt) => ({ ...alt, steps: steps(alt.steps) }))
          : [],
      createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
      label: spec.kind === 'api-key' ? (spec.label ?? null) : null,
      guide: guide
        ? {
            steps: steps(guide.steps),
            reach: guide.reach,
            permissions: guide.permissions.map((p) => ({ name: p.name, access: p.access })),
            expiry: guide.expiry,
            docsUrl: guide.docsUrl,
          }
        : null,
      unavailable: this.unavailableReason(plugin),
    };
  }

  /** Why a plugin cannot be connected here, or `null`: a broker it needs is not configured. */
  private unavailableReason(plugin: ServicePlugin): string | null {
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !isBrokeredSpec(spec)) return null;
    return this.deps.brokers.forProvider(spec.broker.provider)
      ? null
      : brokerNotConfiguredReason(plugin.displayName, spec.broker.provider);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The accounts the actor owns, directly or through a group they belong to now. */
  async listFor(actor: Actor): Promise<AccountView[]> {
    const owned = await this.deps.store.accounts.listOwnedBy([
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g) => ({ kind: 'group' as const, id: g.id })),
    ]);
    return Promise.all(owned.map((c) => this.view(c)));
  }

  async get(actor: Actor, accountId: string): Promise<AccountDetail> {
    const account = await this.host.requireOwned(actor, accountId);
    return {
      ...(await this.view(account)),
      resources: await this.deps.store.accounts.listResources(account.id),
      default_env_choices: this.defaultEnvChoices(account.service),
    };
  }

  /** The environment labels of the service's catalog: what a default may be. */
  defaultEnvChoices(serviceId: string): string[] {
    const registered = this.deps.registry.get(serviceId);
    return registered ? catalogEnvsOf(registered.plugin.catalog) : [];
  }

  /** Operator: the accounts nobody owns any more (`unowned`, or expired with an empty owner group). */
  async listOwnerless(): Promise<AccountView[]> {
    const ownerless = await this.deps.store.accounts.listOwnerless();
    return Promise.all(ownerless.map((c) => this.view(c)));
  }

  /**
   * What the plugin of an account says about withdrawing its grant, with the
   * service's label. Read from the registry alone: it answers for a revoked
   * account too, and for a service whose plugin is gone (nothing is known,
   * so the person removes the access by hand).
   */
  serviceGrantOf(
    account: Pick<AccountRecord, 'service'> & Partial<Pick<AccountRecord, 'metadata'>>,
  ): {
    readonly serviceLabel: string;
    readonly grant: ServiceGrantView;
  } {
    const plugin = this.deps.registry.get(account.service)?.plugin;
    if (!plugin) {
      return {
        serviceLabel: account.service,
        grant: { withdrawnByGateway: false, byHand: null },
      };
    }
    const kind = accountCredentialKind(account, plugin.credential.kind) ?? plugin.credential.kind;
    return {
      serviceLabel: plugin.displayName,
      grant: {
        withdrawnByGateway: canWithdraw(plugin, kind),
        byHand: plugin.manualRevocation ?? null,
      },
    };
  }

  private async view(account: AccountRecord): Promise<AccountView> {
    const registered = this.deps.registry.get(account.service);
    const metadata = account.metadata ?? {};
    const kind = accountCredentialKind(account, registered?.plugin.credential.kind ?? null);
    const pasted = kind === 'api-key';
    // What the service said the account is: the pasted token's `verify`, or the broker's redeem.
    const accountSaid = pasted || kind === 'oauth2';
    return {
      account,
      service_label: registered?.plugin.displayName ?? account.service,
      resource_noun: resourceNounOf(registered?.plugin ?? null),
      service_icon: registered ? serviceIconOf(registered.plugin) : null,
      service_grant: this.serviceGrantOf(account).grant,
      credential_kind: kind,
      way_retired: registered ? isRetiredWay(kind, registered.plugin.credential.kind) : false,
      token_account: accountSaid && typeof metadata.account === 'string' ? metadata.account : null,
      oauth_broker: this.oauthBrokerOf(metadata),
      token_expires_at: pasted ? account.credentialExpiresAt : null,
      token_lacks:
        pasted && registered ? tokenLacks(registered.plugin.credential, metadata.granted) : null,
      owner_label: await this.ownerLabel(account),
      public_key: typeof metadata.public_key === 'string' ? metadata.public_key : null,
      fields: accountPublicFields(account),
      discovery: discoveryOf(metadata.discovery),
    };
  }

  /** The broker named at connect time (`metadata.oauth_broker`), as configured now. */
  private oauthBrokerOf(metadata: Record<string, unknown>): AccountView['oauth_broker'] {
    const name = metadata.oauth_broker;
    if (typeof name !== 'string') return null;
    const source = this.deps.brokers.byName(name);
    return {
      name,
      attested: source?.attested ?? null,
      installed: name === INSTALLED_BROKER,
    };
  }

  private async ownerLabel(account: AccountRecord): Promise<string> {
    const owner = await accountOwnerOf(this.deps.store, account);
    if (owner.kind === 'user') return owner.name ?? 'unknown user';
    return owner.name === null ? 'unknown group' : `group ${owner.name}`;
  }
}

/** A step with its screenshot resolved: served from the plugin's folder, its provenance derived. */
function stepView(
  plugin: ServicePlugin,
  screenshots: TokenGuide['screenshots'],
  step: GuideStep,
): GuideStepView {
  const shot = step.screenshot === undefined ? undefined : screenshots?.[step.screenshot];
  return {
    ...step,
    figure:
      step.screenshot !== undefined && shot !== undefined
        ? {
            url: connectFileUrl(plugin.id, step.screenshot),
            alt: shot.alt,
            attribution: screenshotAttribution(plugin.displayName, shot),
          }
        : null,
  };
}

function discoveryOf(value: unknown): DiscoveryRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'string' || typeof raw.ok !== 'boolean') return null;
  return {
    at: raw.at,
    ok: raw.ok,
    count: typeof raw.count === 'number' ? raw.count : 0,
    error: typeof raw.error === 'string' ? raw.error : null,
    afterCall: afterCallOf(raw.afterCall),
  };
}

function afterCallOf(value: unknown): DiscoveryAfterCallCause | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.missionId !== 'string' || typeof raw.tool !== 'string') return null;
  return { missionId: raw.missionId, tool: raw.tool };
}
