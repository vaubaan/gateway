/**
 * The importer: one v4 organization's bundle into this instance, under one
 * owner (docs/handbook/import-from-v4.md). Three phases, each read from
 * the instance as it is when the phase starts, so a second run completes what
 * the first could not and never duplicates what it did:
 *
 *   1. accounts  the v4 keys that are imported as is (Cloudflare, Vercel,
 *                   Stripe, SSH), created through the connect path of the
 *                   interface (check, first discovery, seal, audit); the
 *                   others listed as "to connect by hand";
 *   2. resources    each v4 binding matched to a discovered resource of the
 *                   owner's accounts, its environment label carried when
 *                   it is a v5 label;
 *   3. missions     one per working v4 token, issued through the issuance
 *                   path of the interface (preview, authority, explicit
 *                   policy), deferred while one of its services has no
 *                   account holding the project's resources.
 *
 * A dry run computes the same plan and writes nothing: it never contacts a
 * service, so what depends on an account still to create is reported as
 * "computed at apply". Nothing here prints; the caller renders the report and
 * prints the mission keys (`cli.ts`).
 *
 * Handbook: docs/handbook/import-from-v4.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { MissionStatus as MissionState, RiskId } from '@vaubaan/shared';

import { findActiveUserByEmail } from '../authority';
import {
  ConnectError,
  importEd25519PrivateKey,
  SshKeyImportError,
  type Actor,
  type AccountService,
  type ImportedFrom,
} from '../accounts';
import { withAssumedEnvs, type MissionService } from '../missions';
import type {
  IssuanceAccount,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
} from '../../lib/missions/model';
import { MISSION_NAME_MAX_LENGTH } from '../../lib/missions/preview';
import { withoutControlCharacters } from './control-characters';
import type { Store } from '../store';
import type { AccountRecord, AccountResourceRecord } from '../store/types';
import type { V4Account, V4Bundle, V4Mission, V4Project } from './bundle';
import {
  isCaseInsensitiveRefService,
  isPastedKeyService,
  pastedKeyFields,
  SSH_SERVICE,
  sshHostFields,
  STRIPE_SERVICE,
  stripeKeyFields,
} from './credential-mapping';
import {
  serviceOfV4Risk,
  translateRisks,
  type CarriedRisk,
  type DroppedRisk,
} from './risk-translation';

/** The environment labels a v4 binding carries over; any other v4 label is left behind. */
export const V5_ENV_LABELS = ['prod', 'staging', 'preview', 'dev'] as const;

/** Missions are issued with the interface's default period: quotas reload every day. */
export const IMPORTED_MISSION_PERIOD_SECONDS = 86_400;

/** The comment of an imported SSH key pair, as the instance's own pairs carry. */
const SSH_KEY_COMMENT = 'vaubaan-gateway';

const SYSTEM = 'vaubaan-v4';

// ─────────────────────────────────────────────────────────────────────────────
// Ports and report
// ─────────────────────────────────────────────────────────────────────────────

export interface ImporterPorts {
  /** The single service list: a v4 service the instance does not ship is reported. */
  readonly registry: PluginRegistry;
  readonly store: Pick<Store, 'users' | 'groups' | 'accounts' | 'missions'>;
  readonly accounts: Pick<AccountService, 'importPastedKey' | 'importSshKey' | 'updateResource'>;
  readonly missions: Pick<MissionService, 'issuanceContext' | 'preview' | 'issue'>;
  /**
   * Where an imported mission came from (M2 of the review): the missions an
   * earlier run issued, by v4 source (`tokens/<id>`), and the scope inside
   * which an issuance is recorded with its source.
   */
  readonly provenance: MissionProvenance;
}

export interface MissionProvenance {
  /**
   * Mission id by v4 source, for the missions the owner issued through an
   * import of this org: the newest one when a source was reissued.
   */
  issued(ownerId: string): Promise<ReadonlyMap<string, string>>;
  /** Runs `act` with `source` recorded on the audit entries it writes. */
  during<T>(source: string, act: () => Promise<T>): Promise<T>;
}

/** The provenance of an imported mission: its v4 token. */
export function missionSourceOf(mission: Pick<V4Mission, 'token_id'>): string {
  return `tokens/${mission.token_id}`;
}

export interface ImportOptions {
  readonly ownerEmail: string;
  /** False: the dry run, nothing is written and no service is contacted. */
  readonly apply: boolean;
  /**
   * `--carry-unbudgeted <quota>`: keep, with this quota and the `approval`
   * gate, a v4 risk no macro-action gives a budget instead of dropping it.
   */
  readonly carryUnbudgeted?: number | null;
  /**
   * `--reissue <v4 token id>`: issue these tokens' missions again even when
   * an import already issued one. The earlier mission is left active.
   */
  readonly reissue?: readonly string[];
}

/** The `--reissue` ids that name no working v4 token of the bundle. */
export function unknownReissueIds(
  bundle: Pick<V4Bundle, 'missions'>,
  reissue: readonly string[],
): string[] {
  const known = new Set(bundle.missions.map((m) => m.token_id));
  return [...new Set(reissue)].filter((id) => !known.has(id));
}

/** Refused before anything was read from or written to the instance's domain. */
export class ImportRefused extends Error {
  constructor(
    readonly reason: 'owner-unknown' | 'owner-ambiguous' | 'reissue-unknown',
    message: string,
  ) {
    super(message);
    this.name = 'ImportRefused';
  }
}

export type AccountStatus =
  /** Dry run: would be created at apply. */
  | 'to-create'
  | 'created'
  /** Created by an earlier run (its `imported_from` marker). */
  | 'already-imported'
  /** The owner already holds one with the same non-secret values. */
  | 'already-connected'
  /** The check, the first discovery or the key was refused: nothing stored. */
  | 'failed'
  | 'service-not-shipped'
  | 'revoked-in-v4';

export interface AccountOutcome {
  readonly source: string;
  readonly service: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly accountId: string | null;
  /** Why it failed, secrets blanked by the caller's redactor. */
  readonly detail: string | null;
}

export interface ByHandOutcome {
  readonly service: string;
  /** `connected` when the owner already holds an account of it. */
  readonly status: 'to-connect' | 'connected' | 'service-not-shipped' | 'revoked-in-v4';
  readonly reason: string;
}

export type LabelStatus =
  | 'to-label'
  | 'labelled'
  | 'already-labelled'
  | 'label-set-by-plugin'
  | 'kept-owner-label'
  | 'not-a-v5-label'
  | 'conflicting-labels'
  | 'not-owned';

export interface ResourceOutcome {
  readonly service: string;
  readonly accountId: string;
  readonly ref: string;
  readonly status: LabelStatus;
  /** The v4 labels it was bound with. */
  readonly v4Labels: readonly string[];
  readonly env: string | null;
}

export interface UnmatchedBinding {
  readonly projectId: string;
  readonly service: string;
  readonly ref: string;
}

export type MissionStatus =
  | 'would-issue'
  | 'issued'
  | 'exists'
  /** Dry run: depends on an account still to create. */
  | 'after-accounts'
  | 'deferred'
  | 'nothing-to-issue'
  | 'refused';

export interface MissionAccountPlan {
  readonly service: string;
  readonly accountId: string;
  readonly refs: readonly string[];
  readonly riskIds: readonly RiskId[];
}

export interface MissionOutcome {
  readonly project: string;
  readonly tokenName: string;
  readonly name: string;
  readonly status: MissionStatus;
  readonly missionId: string | null;
  readonly accounts: readonly MissionAccountPlan[];
  /** Why the mission waits, or what blocked it (deferred, refused). */
  readonly reasons: readonly string[];
  readonly dropped: readonly (DroppedRisk & { readonly service: string })[];
  /** v4 risks no macro-action budgets, kept under approval (`--carry-unbudgeted`). */
  readonly carried: readonly (CarriedRisk & { readonly service: string })[];
  /**
   * `--reissue`: the mission an earlier import issued for the same v4 token,
   * which this run does not revoke.
   */
  readonly previous: {
    readonly missionId: string;
    readonly status: MissionState;
  } | null;
  readonly expanded: readonly {
    readonly v4RiskId: string;
    readonly v5RiskIds: readonly RiskId[];
  }[];
  /** v4 risks of a service the project has no resource on. */
  readonly unbound: readonly string[];
}

/** A key issued by this run: printed once by the caller, never stored, never logged. */
export interface IssuedKey {
  readonly project: string;
  readonly mission_id: string;
  readonly token_name: string;
  readonly key: string;
}

export interface ImportReport {
  readonly apply: boolean;
  readonly org: string;
  readonly owner: string;
  readonly accounts: readonly AccountOutcome[];
  readonly byHand: readonly ByHandOutcome[];
  readonly resources: readonly ResourceOutcome[];
  readonly unmatched: readonly UnmatchedBinding[];
  readonly missions: readonly MissionOutcome[];
  readonly skipped: V4Bundle['skipped'];
  readonly keys: readonly IssuedKey[];
  /** Something the run tried was refused (an account, a mission). */
  readonly failed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized bundle
// ─────────────────────────────────────────────────────────────────────────────

/** One credential of the bundle that becomes an account. */
interface Source {
  readonly source: string;
  readonly service: string;
  readonly displayName: string;
  readonly revokedInV4: boolean;
  /** The non-secret values a hand-made account is recognised by. */
  readonly visibleFields: Readonly<Record<string, string>>;
  /** The projects bound to it in v4: a mission waits for it in a dry run. */
  readonly projectIds: ReadonlySet<string>;
  readonly create: (actor: Actor) => Promise<{ readonly account: AccountRecord }>;
}

type Matcher =
  | { readonly kind: 'ref'; readonly ref: string; readonly ignoreCase: boolean }
  | {
      readonly kind: 'stripe-account';
      readonly accountId: string;
      /** The one mode v4 used for the project (`live ?? test`). */
      readonly mode: 'test' | 'live';
    };

/** One v4 binding of a project, deduplicated. */
interface Binding {
  readonly projectId: string;
  readonly service: string;
  readonly matcher: Matcher;
  readonly label: string;
  /** Every non-null v4 label the duplicates carried. */
  readonly v4Labels: readonly string[];
}

function bindingKey(b: Pick<Binding, 'projectId' | 'service' | 'label'>): string {
  return `${b.projectId}\u0000${b.service}\u0000${b.label}`;
}

/** v4 holds duplicated rows: one binding per (project, service, resource), labels merged. */
export function normalizeBindings(bundle: V4Bundle): Binding[] {
  const merged = new Map<string, { binding: Binding; labels: Set<string> }>();
  const add = (binding: Omit<Binding, 'v4Labels'>, label: string | null) => {
    const key = bindingKey(binding);
    const entry = merged.get(key) ?? { binding: { ...binding, v4Labels: [] }, labels: new Set() };
    if (label !== null && label.trim() !== '') entry.labels.add(label.trim());
    merged.set(key, entry);
  };
  for (const b of bundle.bindings) {
    // Stripe and SSH resources come from their own tables in v4.
    if (b.service === STRIPE_SERVICE || b.service === SSH_SERVICE) continue;
    add(
      {
        projectId: b.project_id,
        service: b.service,
        matcher: {
          kind: 'ref',
          ref: b.resource_ref,
          ignoreCase: isCaseInsensitiveRefService(b.service),
        },
        label: b.resource_ref,
      },
      b.environment,
    );
  }
  for (const account of bundle.stripe_accounts) {
    for (const { project_id: projectId, mode } of account.projects) {
      add(
        {
          projectId,
          service: STRIPE_SERVICE,
          matcher: { kind: 'stripe-account', accountId: account.account_id, mode },
          label: `${account.account_id}/${mode}`,
        },
        null,
      );
    }
  }
  for (const host of bundle.ssh_hosts) {
    for (const projectId of host.project_ids) {
      add(
        {
          projectId,
          service: SSH_SERVICE,
          matcher: { kind: 'ref', ref: host.host_address, ignoreCase: true },
          label: host.host_address,
        },
        null,
      );
    }
  }
  return [...merged.values()].map(({ binding, labels }) => ({
    ...binding,
    v4Labels: [...labels].sort(),
  }));
}

function matches(
  matcher: Matcher,
  resource: Pick<AccountResourceRecord, 'ref' | 'metadata' | 'env'>,
): boolean {
  if (matcher.kind === 'stripe-account') {
    // The project's own mode only: a test-mode project never reaches live money.
    const account =
      resource.metadata?.account_id === matcher.accountId ||
      resource.ref.startsWith(`${matcher.accountId}/`);
    return (
      account &&
      (resource.env === matcher.mode || resource.ref === `${matcher.accountId}/${matcher.mode}`)
    );
  }
  if (resource.ref === matcher.ref) return true;
  return matcher.ignoreCase && resource.ref.toLowerCase() === matcher.ref.toLowerCase();
}

function isV5Label(label: string): boolean {
  return (V5_ENV_LABELS as readonly string[]).includes(label);
}

// ─────────────────────────────────────────────────────────────────────────────
// The importer
// ─────────────────────────────────────────────────────────────────────────────

/** An account the owner may build from, with its resource rows (who set each label). */
interface Held {
  readonly issuance: IssuanceAccount;
  readonly records: readonly AccountResourceRecord[];
  readonly importedFromOrg: boolean;
}

export class Importer {
  constructor(private readonly ports: ImporterPorts) {}

  async run(bundle: V4Bundle, options: ImportOptions): Promise<ImportReport> {
    const reissue = new Set(options.reissue ?? []);
    const unknown = unknownReissueIds(bundle, [...reissue]);
    if (unknown.length > 0) {
      throw new ImportRefused(
        'reissue-unknown',
        `--reissue names ${unknown.length} token(s) that are not working v4 tokens of this bundle`,
      );
    }
    const actor = await this.ownerOf(options.ownerEmail);
    const org = bundle.organization.slug;
    const sources = this.sourcesOf(bundle);

    const accounts: AccountOutcome[] = [];
    for (const source of sources) {
      accounts.push(await this.connect(actor, source, options.apply));
    }
    const byHand = await this.byHand(actor, bundle);

    const bindings = normalizeBindings(bundle);
    const held = await this.held(actor, org);
    const labels = this.planLabels(held, bindings);
    const resources: ResourceOutcome[] = [];
    for (const plan of labels) {
      resources.push(await this.label(actor, plan, options.apply));
    }

    // Missions are planned against the instance as the labels left it; a dry run
    // reads the labels it would set as set, so that it says what --apply does.
    const assumedEnvs = options.apply ? new Map<string, string>() : plannedEnvs(labels);
    const afterLabels = options.apply ? await this.held(actor, org) : withLabels(held, assumedEnvs);
    const pending = new Set(accounts.filter((c) => c.status === 'to-create').map((c) => c.source));
    const waiting = sources.filter((s) => pending.has(s.source));
    const missions: MissionOutcome[] = [];
    const keys: IssuedKey[] = [];
    const names = missionNamesOf(bundle);
    const issued = await this.ports.provenance.issued(actor.user.id);
    for (const mission of bundle.missions) {
      const project = bundle.projects.find((p) => p.id === mission.project_id);
      if (!project) continue; // the schema refuses such a bundle
      const name = names.get(mission.token_id) ?? project.slug;
      const outcome = await this.mission(actor, {
        project,
        mission,
        name,
        bindings: bindings.filter((b) => b.projectId === project.id),
        held: afterLabels,
        waiting,
        issued,
        reissue: reissue.has(mission.token_id),
        carryUnbudgeted: options.carryUnbudgeted ?? null,
        apply: options.apply,
        assumedEnvs,
      });
      missions.push(outcome.outcome);
      if (outcome.key) keys.push(outcome.key);
    }

    return {
      apply: options.apply,
      org,
      owner: actor.user.email,
      accounts,
      byHand,
      resources,
      unmatched: unmatchedOf(bindings, afterLabels, this.ports.registry),
      missions,
      skipped: bundle.skipped,
      keys,
      failed:
        accounts.some((c) => c.status === 'failed') || missions.some((m) => m.status === 'refused'),
    };
  }

  // ── Owner ─────────────────────────────────────────────────────────────────

  private async ownerOf(email: string): Promise<Actor> {
    const lookup = await findActiveUserByEmail(this.ports.store.users, email);
    if (!lookup.found) {
      throw lookup.reason === 'ambiguous'
        ? new ImportRefused(
            'owner-ambiguous',
            'several active users of this instance have that email; the owner must be one person',
          )
        : new ImportRefused(
            'owner-unknown',
            'no active user of this instance has that email: the owner signs in once, then the import runs',
          );
    }
    return { user: lookup.user, groups: await this.ports.store.groups.groupsOf(lookup.user.id) };
  }

  // ── Accounts ───────────────────────────────────────────────────────────

  private importedFrom(bundle: V4Bundle, source: string): ImportedFrom {
    return { system: SYSTEM, org: bundle.organization.slug, source };
  }

  private visibleFieldsOf(
    service: string,
    kind: 'api-key' | 'ssh-key',
    values: Record<string, string>,
  ) {
    const spec = this.ports.registry.get(service)?.plugin.credential;
    const fields = spec && spec.kind === kind ? spec.fields : [];
    const visible: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (!field.secret && value !== undefined) visible[field.name] = value;
    }
    return visible;
  }

  private label4(service: string): string {
    return this.ports.registry.get(service)?.plugin.displayName ?? service;
  }

  private sourcesOf(bundle: V4Bundle): Source[] {
    const org = bundle.organization.slug;
    const sources: Source[] = [];
    const projectsOf = (service: string) =>
      new Set(bundle.bindings.filter((b) => b.service === service).map((b) => b.project_id));

    for (const account of bundle.accounts) {
      const mapped = pastedKeyFields(account);
      if (!mapped.ok) continue;
      const source = `service_admins/${account.id}`;
      const importedFrom = this.importedFrom(bundle, source);
      const displayName = `${this.label4(account.service)} (v4 ${org})`;
      sources.push({
        source,
        service: account.service,
        displayName,
        revokedInV4: account.status === 'revoked',
        visibleFields: this.visibleFieldsOf(account.service, 'api-key', mapped.fields),
        projectIds: projectsOf(account.service),
        create: (actor) =>
          this.ports.accounts.importPastedKey(actor, account.service, {
            displayName,
            fields: mapped.fields,
            importedFrom,
          }),
      });
    }

    for (const account of bundle.stripe_accounts) {
      const source = `stripe_bindings/${account.account_id}`;
      const importedFrom = this.importedFrom(bundle, source);
      const fields = stripeKeyFields(account);
      const displayName = `${this.label4(STRIPE_SERVICE)} ${account.account_id}`;
      sources.push({
        source,
        service: STRIPE_SERVICE,
        displayName,
        revokedInV4: false,
        visibleFields: this.visibleFieldsOf(STRIPE_SERVICE, 'api-key', fields),
        projectIds: new Set(account.projects.map((p) => p.project_id)),
        create: (actor) =>
          this.ports.accounts.importPastedKey(actor, STRIPE_SERVICE, {
            displayName,
            fields,
            importedFrom,
          }),
      });
    }

    for (const host of bundle.ssh_hosts) {
      const source = `ssh_bindings/${host.source_org}/${host.host_slug}`;
      const importedFrom = this.importedFrom(bundle, source);
      const fields = sshHostFields(host);
      sources.push({
        source,
        service: SSH_SERVICE,
        displayName: host.host_slug,
        revokedInV4: false,
        visibleFields: this.visibleFieldsOf(SSH_SERVICE, 'ssh-key', fields),
        projectIds: new Set(host.project_ids),
        create: (actor) => {
          // Converted here, at apply only: the dry run never touches the key.
          const keyPair = importEd25519PrivateKey(host.private_key, SSH_KEY_COMMENT);
          return this.ports.accounts.importSshKey(actor, {
            serviceId: SSH_SERVICE,
            displayName: host.host_slug,
            fields,
            keyPair,
            importedFrom,
          });
        },
      });
    }
    return sources;
  }

  private async owned(actor: Actor): Promise<AccountRecord[]> {
    const owned = await this.ports.store.accounts.listOwnedBy([
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g) => ({ kind: 'group' as const, id: g.id })),
    ]);
    return owned.filter((c) => c.status !== 'revoked');
  }

  private async connect(actor: Actor, source: Source, apply: boolean): Promise<AccountOutcome> {
    const outcome = (
      status: AccountStatus,
      accountId: string | null = null,
      detail: string | null = null,
    ): AccountOutcome => ({
      source: source.source,
      service: source.service,
      displayName: source.displayName,
      status,
      accountId,
      detail,
    });
    if (!this.ports.registry.has(source.service)) return outcome('service-not-shipped');
    if (source.revokedInV4) return outcome('revoked-in-v4');

    const owned = (await this.owned(actor)).filter((c) => c.service === source.service);
    const imported = owned.find((c) => importedSourceOf(c) === source.source);
    if (imported) return outcome('already-imported', imported.id);
    const byHand = owned.find((c) =>
      sameVisibleFields(visibleFieldsOfRecord(c), source.visibleFields),
    );
    if (byHand) return outcome('already-connected', byHand.id);
    if (!apply) return outcome('to-create');

    try {
      const created = await source.create(actor);
      return outcome('created', created.account.id);
    } catch (err) {
      if (err instanceof ConnectError || err instanceof SshKeyImportError) {
        return outcome('failed', null, err.message);
      }
      throw err;
    }
  }

  private async byHand(actor: Actor, bundle: V4Bundle): Promise<ByHandOutcome[]> {
    const owned = await this.owned(actor);
    const outcomes: ByHandOutcome[] = [];
    for (const account of bundle.accounts) {
      if (isPastedKeyService(account.service) && pastedKeyFields(account).ok) continue;
      outcomes.push(this.byHandOf(account, owned));
    }
    return outcomes;
  }

  private byHandOf(account: V4Account, owned: readonly AccountRecord[]): ByHandOutcome {
    const service = account.service;
    if (!this.ports.registry.has(service)) {
      return {
        service,
        status: 'service-not-shipped',
        reason: 'this instance ships no plugin for it',
      };
    }
    if (account.status === 'revoked') {
      return { service, status: 'revoked-in-v4', reason: 'the v4 account was revoked' };
    }
    const reason = isPastedKeyService(service)
      ? (pastedKeyFields(account) as { readonly reason: string }).reason
      : account.installation_id !== null
        ? 'a v4 GitHub App installation: connect this account with a fine-grained token'
        : 'a v4 OAuth grant: sharing its refresh token would break v4 or v5';
    return {
      service,
      status: owned.some((c) => c.service === service) ? 'connected' : 'to-connect',
      reason,
    };
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  private async held(actor: Actor, org: string): Promise<Held[]> {
    const context = await this.ports.missions.issuanceContext({ id: actor.user.id });
    const owned = new Map((await this.owned(actor)).map((c) => [c.id, c]));
    const held: Held[] = [];
    for (const issuance of context) {
      const record = owned.get(issuance.id);
      held.push({
        issuance,
        records: await this.ports.store.accounts.listResources(issuance.id),
        importedFromOrg: record !== undefined && importedOrgOf(record) === org,
      });
    }
    return held;
  }

  private planLabels(held: readonly Held[], bindings: readonly Binding[]): LabelPlan[] {
    const perResource = new Map<
      string,
      { held: Held; record: AccountResourceRecord; labels: Set<string> }
    >();
    for (const binding of bindings) {
      for (const h of held) {
        if (h.issuance.service !== binding.service) continue;
        for (const record of h.records) {
          if (!matches(binding.matcher, record)) continue;
          const entry = perResource.get(record.id) ?? {
            held: h,
            record,
            labels: new Set<string>(),
          };
          binding.v4Labels.forEach((l) => entry.labels.add(l));
          perResource.set(record.id, entry);
        }
      }
    }
    const plans: LabelPlan[] = [];
    for (const { held: h, record, labels } of perResource.values()) {
      if (labels.size === 0) continue;
      const v4Labels = [...labels].sort();
      const v5 = v4Labels.filter(isV5Label);
      const plan = (status: LabelStatus, env: string | null = record.env): LabelPlan => ({
        accountId: h.issuance.id,
        service: h.issuance.service,
        resourceId: record.id,
        ref: record.ref,
        status,
        v4Labels,
        env,
      });
      if (v5.length === 0) plans.push(plan('not-a-v5-label'));
      else if (v5.length > 1) plans.push(plan('conflicting-labels'));
      else if (record.env === v5[0]) plans.push(plan('already-labelled'));
      else if (record.envSource === 'plugin') plans.push(plan('label-set-by-plugin'));
      else if (record.env !== null) plans.push(plan('kept-owner-label'));
      // Shared with the owner: only the account's owner labels its resources.
      else if (h.issuance.basis !== 'owner') plans.push(plan('not-owned'));
      else plans.push(plan('to-label', v5[0] ?? null));
    }
    return plans;
  }

  private async label(actor: Actor, plan: LabelPlan, apply: boolean): Promise<ResourceOutcome> {
    const outcome: ResourceOutcome = {
      service: plan.service,
      accountId: plan.accountId,
      ref: plan.ref,
      status: plan.status,
      v4Labels: plan.v4Labels,
      env: plan.env,
    };
    if (plan.status !== 'to-label' || !apply || plan.env === null) return outcome;
    await this.ports.accounts.updateResource(actor, plan.accountId, plan.resourceId, {
      env: plan.env,
    });
    return { ...outcome, status: 'labelled' };
  }

  // ── Missions ──────────────────────────────────────────────────────────────

  private async mission(
    actor: Actor,
    input: {
      readonly project: V4Project;
      readonly mission: V4Mission;
      readonly name: string;
      readonly bindings: readonly Binding[];
      readonly held: readonly Held[];
      readonly waiting: readonly Source[];
      /** Missions earlier imports issued, by v4 source. */
      readonly issued: ReadonlyMap<string, string>;
      /** `--reissue`: issue again even when an earlier import issued it. */
      readonly reissue: boolean;
      readonly carryUnbudgeted: number | null;
      readonly apply: boolean;
      /** Dry run: the labels the run would set, by resource id, read as set by the check. */
      readonly assumedEnvs: ReadonlyMap<string, string>;
    },
  ): Promise<{ readonly outcome: MissionOutcome; readonly key: IssuedKey | null }> {
    const { project, mission, name, bindings, held } = input;
    const base = {
      project: project.name,
      tokenName: mission.token_name,
      name,
      missionId: null,
      accounts: [] as MissionAccountPlan[],
      reasons: [] as string[],
      dropped: [] as (DroppedRisk & { service: string })[],
      carried: [] as (CarriedRisk & { service: string })[],
      previous: null as MissionOutcome['previous'],
      expanded: [] as { v4RiskId: string; v5RiskIds: RiskId[] }[],
      unbound: [] as string[],
    };
    const done = (status: MissionStatus, extra: Partial<MissionOutcome> = {}) => ({
      outcome: { ...base, status, ...extra },
      key: null,
    });

    // Recognised by provenance, never by name: a mission the owner made by hand
    // with the same name is not this one, and a renamed import still is.
    const source = missionSourceOf(mission);
    const existingId = input.issued.get(source);
    if (existingId !== undefined) {
      const existing = (await this.ports.store.missions.listForCreator(actor.user.id)).find(
        (m) => m.id === existingId,
      );
      if (existing && input.reissue) {
        // Named in the report, never revoked here: its key stays in use until
        // the new one is installed (ADR amendment of 2026-10-15).
        base.previous = { missionId: existing.id, status: existing.status };
      } else if (existing) {
        return done('exists', {
          missionId: existing.id,
          reasons:
            existing.status === 'revoked'
              ? ['revoked by its owner since the import: not issued again']
              : [],
        });
      }
    }

    const services = [...new Set(bindings.map((b) => b.service))].filter((p) =>
      this.ports.registry.has(p),
    );
    const notShipped = [...new Set(bindings.map((b) => b.service))].filter(
      (p) => !this.ports.registry.has(p),
    );
    base.reasons.push(...notShipped.map((p) => `${p}: this instance ships no plugin for it`));

    const chosen: { service: string; held: Held; records: AccountResourceRecord[] }[] = [];
    const deferred: string[] = [];
    let waitsForCreation = false;
    for (const service of services) {
      const own = bindings.filter((b) => b.service === service);
      const best = bestAccount(held, service, own);
      if (best && best.records.length > 0) {
        chosen.push({ service, held: best.held, records: best.records });
        continue;
      }
      if (input.waiting.some((s) => s.service === service && s.projectIds.has(project.id))) {
        waitsForCreation = true;
        continue;
      }
      const label = this.label4(service);
      deferred.push(
        held.some((h) => h.issuance.service === service)
          ? `${label}: none of the project's resources (${own.map((b) => b.label).join(', ')}) is among the discovered resources of your accounts; refresh their discovery`
          : `${label}: no account connected yet; connect one, then run the import again`,
      );
    }
    if (deferred.length > 0) return done('deferred', { reasons: [...base.reasons, ...deferred] });
    if (waitsForCreation) return done('after-accounts');

    const plans: MissionAccountPlan[] = [];
    const draftAccounts: MissionDraft['accounts'][number][] = [];
    const inMission = new Set(chosen.map((c) => c.service));
    base.unbound.push(
      ...mission.accepted_risks.filter((id) => {
        const service = serviceOfV4Risk(id);
        return service === null || !inMission.has(service);
      }),
    );
    for (const { service, held: h, records } of chosen) {
      const selected: IssuanceResource[] = h.issuance.resources.filter((r) =>
        records.some((record) => record.id === r.id),
      );
      const ids = mission.accepted_risks.filter((id) => serviceOfV4Risk(id) === service);
      const translation = translateRisks(
        ids,
        h.issuance,
        selected,
        mission.denied_risks,
        input.carryUnbudgeted === null ? null : { quota: input.carryUnbudgeted },
      );
      base.dropped.push(...translation.dropped.map((d) => ({ ...d, service })));
      base.carried.push(...translation.carried.map((c) => ({ ...c, service })));
      base.expanded.push(
        ...translation.expanded.map((e) => ({ v4RiskId: e.v4RiskId, v5RiskIds: [...e.v5RiskIds] })),
      );
      if (translation.entries.length === 0) {
        base.reasons.push(`${this.label4(service)}: no v4 risk of this service carries over`);
        continue;
      }
      plans.push({
        service,
        accountId: h.issuance.id,
        refs: selected.map((r) => r.ref),
        riskIds: translation.entries.map((e) => e.risk_id),
      });
      draftAccounts.push({
        account_id: h.issuance.id,
        resources: { scope: 'selected', resource_ids: selected.map((r) => r.id) },
        everything_i_hold: false,
        policy: translation.entries.map((e) => ({
          risk_id: e.risk_id,
          quota: e.quota,
          rate_limit: e.rate_limit,
          gate: e.gate,
        })),
      });
    }
    base.accounts.push(...plans);
    if (draftAccounts.length === 0) return done('nothing-to-issue');

    const draft: MissionDraft = {
      name,
      accounts: draftAccounts,
      period: { kind: 'recurring', length_seconds: IMPORTED_MISSION_PERIOD_SECONDS },
      expires_at: mission.expires_at,
    };
    const subject = { id: actor.user.id };
    if (!input.apply) {
      const preview = await this.ports.missions.preview(subject, draft, {
        assumedEnvs: input.assumedEnvs,
      });
      return preview.ok
        ? done('would-issue')
        : done('refused', { reasons: [...base.reasons, ...issueLines(preview.issues)] });
    }
    const issued = await this.ports.provenance.during(source, () =>
      this.ports.missions.issue(subject, draft),
    );
    if (!issued.ok) {
      return done('refused', {
        reasons: [
          ...base.reasons,
          ...(issued.reason === 'refused'
            ? issueLines(issued.preview.issues)
            : issued.reason === 'limit-reached'
              ? [issued.message]
              : ['not found']),
        ],
      });
    }
    return {
      outcome: { ...base, status: 'issued', missionId: issued.mission.id },
      key: {
        project: project.name,
        mission_id: issued.mission.id,
        token_name: mission.token_name,
        key: issued.token.secret,
      },
    };
  }
}

interface LabelPlan {
  readonly accountId: string;
  readonly service: string;
  readonly resourceId: string;
  readonly ref: string;
  readonly status: LabelStatus;
  readonly v4Labels: readonly string[];
  readonly env: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function importedFromOf(c: Pick<AccountRecord, 'metadata'>): Record<string, unknown> | null {
  const marker = c.metadata?.imported_from;
  if (typeof marker !== 'object' || marker === null) return null;
  const record = marker as Record<string, unknown>;
  return record.system === SYSTEM ? record : null;
}

function importedSourceOf(c: Pick<AccountRecord, 'metadata'>): string | null {
  const source = importedFromOf(c)?.source;
  return typeof source === 'string' ? source : null;
}

function importedOrgOf(c: Pick<AccountRecord, 'metadata'>): string | null {
  const org = importedFromOf(c)?.org;
  return typeof org === 'string' ? org : null;
}

function visibleFieldsOfRecord(c: Pick<AccountRecord, 'metadata'>): Record<string, string> {
  const fields = c.metadata?.fields;
  if (typeof fields !== 'object' || fields === null) return {};
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Two sets of non-secret values describe the same account: they share at
 * least one key and agree on every shared key. A service whose form has no
 * non-secret value (a Cloudflare token) is never recognised this way.
 */
export function sameVisibleFields(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const shared = Object.keys(a).filter((k) => k in b);
  return shared.length > 0 && shared.every((k) => a[k] === b[k]);
}

function bestAccount(
  held: readonly Held[],
  service: string,
  bindings: readonly Binding[],
): { readonly held: Held; readonly records: AccountResourceRecord[] } | null {
  let best: { held: Held; records: AccountResourceRecord[] } | null = null;
  for (const h of held) {
    if (h.issuance.service !== service) continue;
    const records = h.records.filter(
      (r) => r.staleSince === null && bindings.some((b) => matches(b.matcher, r)),
    );
    const better =
      best === null ||
      records.length > best.records.length ||
      (records.length === best.records.length && h.importedFromOrg && !best.held.importedFromOrg);
    if (better) best = { held: h, records };
  }
  return best;
}

/** The labels the run would set, by resource id. */
function plannedEnvs(plans: readonly LabelPlan[]): Map<string, string> {
  return new Map(
    plans.flatMap((p) =>
      p.status === 'to-label' && p.env !== null ? [[p.resourceId, p.env] as const] : [],
    ),
  );
}

/** The held accounts with the labels the dry run would set. */
function withLabels(held: readonly Held[], planned: ReadonlyMap<string, string>): Held[] {
  if (planned.size === 0) return [...held];
  return held.map((h) => ({
    ...h,
    issuance: withAssumedEnvs([h.issuance], planned)[0] ?? h.issuance,
    records: h.records.map((r) => {
      const env = planned.get(r.id);
      return env === undefined ? r : { ...r, env };
    }),
  }));
}

function unmatchedOf(
  bindings: readonly Binding[],
  held: readonly Held[],
  registry: PluginRegistry,
): UnmatchedBinding[] {
  return bindings
    .filter((b) => registry.has(b.service))
    .filter(
      (b) =>
        !held.some(
          (h) => h.issuance.service === b.service && h.records.some((r) => matches(b.matcher, r)),
        ),
    )
    .map((b) => ({ projectId: b.projectId, service: b.service, ref: b.label }));
}

function issueLines(issues: readonly PreviewIssue[]): string[] {
  return issues.map((issue) => `${issue.code}: ${issue.message}`);
}

/** Control characters and runs of blanks out: a name is one readable line. */
export function oneLineName(value: string): string {
  return withoutControlCharacters(value).replace(/\s+/g, ' ').trim();
}

/**
 * The name of each imported mission, by v4 token id: the project's name, or
 * `<project> — <token>` when the project has several working tokens or
 * another project shares its name. Cleaned to one line and cut to the
 * interface's limit; still-equal names get the project's slug.
 */
export function missionNamesOf(
  bundle: Pick<V4Bundle, 'projects' | 'missions'>,
): Map<string, string> {
  const projects = new Map(bundle.projects.map((p) => [p.id, p]));
  const base = (projectId: string) => {
    const project = projects.get(projectId);
    return project ? oneLineName(project.name) || project.slug : projectId;
  };
  const tokensPerProject = new Map<string, number>();
  const projectsPerName = new Map<string, Set<string>>();
  for (const m of bundle.missions) {
    tokensPerProject.set(m.project_id, (tokensPerProject.get(m.project_id) ?? 0) + 1);
    const name = base(m.project_id);
    projectsPerName.set(name, (projectsPerName.get(name) ?? new Set()).add(m.project_id));
  }
  const cut = (name: string) => name.slice(0, MISSION_NAME_MAX_LENGTH).trim();
  const names = new Map<string, string>();
  for (const m of bundle.missions) {
    const project = base(m.project_id);
    const shared = (projectsPerName.get(project)?.size ?? 0) > 1;
    const several = (tokensPerProject.get(m.project_id) ?? 0) > 1;
    const slug = projects.get(m.project_id)?.slug ?? '';
    const qualifier = shared ? `${slug}/${m.token_name}` : m.token_name;
    names.set(m.token_id, cut(shared || several ? `${project} — ${qualifier}` : project));
  }
  return names;
}
