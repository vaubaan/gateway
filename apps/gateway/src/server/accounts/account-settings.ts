/**
 * The owner's edits of an account (ADR connect-driver-and-resource-curation): a
 * resource's name, label, visibility and settings, the account's default environment,
 * its name. Each one audited when it changes something; an unchanged value writes
 * nothing. The account service delegates these edits here and lends ownership and the
 * catalog's environments (`AccountSettingsHost`).
 */
import { ownResourceEnv } from '../store/resource-env';
import { toIso } from '../store/clock';
import type { AccountRecord, AccountResourceRecord } from '../store/types';
import type { AccountServiceDeps, Actor, ResourcePatch } from './account-views';
import { ConnectError } from './errors';
import { cleanName, editableMetadataKeys, parseEnvLabel, parseListValue } from './input';

/** What the owner's edits read of the account service. */
export interface AccountSettingsHost {
  requireOwned(actor: Actor, accountId: string): Promise<AccountRecord>;
  defaultEnvChoices(serviceId: string): string[];
}

export class AccountSettings {
  constructor(
    private readonly deps: AccountServiceDeps,
    private readonly host: AccountSettingsHost,
  ) {}

  // ── Resources ─────────────────────────────────────────────────────────────

  async updateResource(
    actor: Actor,
    accountId: string,
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<AccountResourceRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    const { accounts } = this.deps.store;
    let resource = await accounts.getResource(resourceId);
    if (!resource || resource.accountId !== account.id) throw new ConnectError('not-found');
    const before = resourceAuditView(resource);

    // Validate everything before the first write.
    let env: string | null | undefined;
    if (patch.env !== undefined) {
      const parsed = parseEnvLabel(patch.env);
      if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
      // Compared with the resource's own label: one inherited from the account's
      // default is not the resource's, and naming the same label pins it.
      if (parsed.env !== ownResourceEnv(resource)) {
        if (resource.envSource === 'plugin') throw new ConnectError('label-read-only');
        env = parsed.env;
      }
    }
    let ownerMetadata: Record<string, unknown> | undefined;
    if (patch.metadata) {
      const editable = new Set(editableMetadataKeys(resource.metadata));
      for (const [key, raw] of Object.entries(patch.metadata)) {
        if (!editable.has(key)) {
          throw new ConnectError('invalid-input', `'${key}' is not an editable setting`);
        }
        const parsed = parseListValue(raw);
        if (!parsed.ok) throw new ConnectError('invalid-input', `${key}: ${parsed.problem}`);
        if (sameList(parsed.list, resource.metadata?.[key])) continue;
        ownerMetadata = { ...(ownerMetadata ?? resource.ownerMetadata ?? {}), [key]: parsed.list };
      }
    }

    if (patch.displayName !== undefined) {
      const name = cleanName(patch.displayName);
      if (name === null) {
        if (resource.displayNameEdited) await accounts.setResourceDisplayName(resource.id, null);
      } else if (name !== resource.displayName) {
        await accounts.setResourceDisplayName(resource.id, name);
      }
    }
    if (env !== undefined) {
      const before = await this.deps.futureResources?.snapshot(account.id);
      await accounts.setResourceEnv(resource.id, env);
      if (before) await this.deps.futureResources?.settle(account.id, before, actor.user.id);
    }
    if (patch.hidden !== undefined && patch.hidden !== resource.hidden) {
      await accounts.setResourceHidden(resource.id, patch.hidden);
    }
    if (ownerMetadata) await accounts.setResourceOwnerMetadata(resource.id, ownerMetadata);

    resource = (await accounts.getResource(resource.id)) ?? resource;
    await this.auditResourceEdit(actor, account, before, resourceAuditView(resource));
    this.deps.logger.info('resource edited by its owner', {
      account_id: account.id,
      resource_id: resource.id,
      user_id: actor.user.id,
    });
    return resource;
  }

  /**
   * The owner's default environment for the account's unlabelled resources
   * (ADR connect-driver-and-resource-curation). `raw` is one of the catalog's
   * environment labels (`defaultEnvChoices`), or blank for none. A resource's own
   * label, the owner's or the plugin's, always wins over it. Audited
   * (`account-default-env-set`) when it changes; an unchanged value writes nothing.
   */
  async setDefaultEnv(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const parsed = parseEnvLabel(raw);
    if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
    const choices = this.host.defaultEnvChoices(account.service);
    if (parsed.env !== null && !choices.includes(parsed.env)) {
      throw new ConnectError(
        'invalid-input',
        choices.length === 0
          ? 'no permission of this service depends on an environment'
          : `'${parsed.env}' is not an environment of this service (${choices.join(', ')})`,
      );
    }
    if (parsed.env === account.defaultEnv) return account;
    const before = await this.deps.futureResources?.snapshot(account.id);
    const updated = await this.deps.store.accounts.setDefaultEnv(account.id, parsed.env);
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'account-default-env-set',
      object: { type: 'account', id: account.id },
      before: { default_env: account.defaultEnv },
      after: { default_env: updated.defaultEnv },
    });
    this.deps.logger.info('account default environment set by its owner', {
      account_id: account.id,
      user_id: actor.user.id,
      default_env: updated.defaultEnv,
    });
    // The resources inheriting the default were relabelled with it.
    if (before) await this.deps.futureResources?.settle(account.id, before, actor.user.id);
    return updated;
  }

  /**
   * The owner's name for the account: how it reads in the lists, the missions and the
   * Record. Any owner, a personal (`host`) account included; never a disconnected one.
   * Blank is refused; an unchanged name writes nothing. Audited (`account-renamed`).
   */
  async rename(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const name = cleanName(raw);
    if (name === null) throw new ConnectError('invalid-input', 'the name cannot be empty');
    if (name === account.displayName) return account;
    const updated = await this.deps.store.accounts.setDisplayName(account.id, name);
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'account-renamed',
      object: { type: 'account', id: account.id },
      before: { display_name: account.displayName },
      after: { display_name: updated.displayName },
    });
    this.deps.logger.info('account renamed by its owner', {
      account_id: account.id,
      user_id: actor.user.id,
    });
    return updated;
  }

  /** One entry per save that changed something; a save that changed nothing writes none. */
  private async auditResourceEdit(
    actor: Actor,
    account: AccountRecord,
    before: ResourceAuditView,
    after: ResourceAuditView,
  ): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'resource-edited',
      object: { type: 'account', id: account.id },
      before,
      after,
    });
  }

  private nowIso(): string {
    return toIso(this.deps.clock.now());
  }
}

/** What a `resource-edited` audit entry says of a resource: the fields its owner can edit. */
interface ResourceAuditView {
  readonly resource_id: string;
  readonly ref: string;
  readonly display_name: string;
  readonly env: string | null;
  readonly hidden: boolean;
  readonly owner_metadata: Record<string, unknown> | null;
}

function resourceAuditView(resource: AccountResourceRecord): ResourceAuditView {
  return {
    resource_id: resource.id,
    ref: resource.ref,
    display_name: resource.displayName,
    // The resource's own label, the one edited here; the account's default is audited apart.
    env: ownResourceEnv(resource),
    hidden: resource.hidden,
    owner_metadata: resource.ownerMetadata,
  };
}

function sameList(list: readonly string[], current: unknown): boolean {
  return (
    Array.isArray(current) &&
    current.length === list.length &&
    current.every((value, index) => value === list[index])
  );
}
