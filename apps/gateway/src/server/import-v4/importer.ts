/**
 * The importer: one v4 organization's bundle into this instance, under one
 * owner (ADR import-from-v4-one-shot-importer). Three phases, each read from
 * the instance as it is when the phase starts, so a second run completes what
 * the first could not and never duplicates what it did:
 *
 *   1. connections  the v4 keys that are imported as is (Cloudflare, Vercel,
 *                   Stripe, SSH), created through the connect path of the
 *                   interface (check, first discovery, seal, audit); the
 *                   others listed as "to connect by hand";
 *   2. resources    each v4 binding matched to a discovered resource of the
 *                   owner's connections, its environment label carried when
 *                   it is a v5 label;
 *   3. missions     one per working v4 token, issued through the issuance
 *                   path of the interface (preview, authority, explicit
 *                   policy), deferred while one of its services has no
 *                   connection holding the project's resources.
 *
 * A dry run computes the same plan and writes nothing: it never contacts a
 * provider, so what depends on a connection still to create is reported as
 * "computed at apply". Nothing here prints; the caller renders the report and
 * prints the mission keys (`cli.ts`).
 *
 * Handbook: docs/handbook/import-from-v4.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { credentialSpecFor } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import { findActiveUserByEmail } from '../authority';
import {
  ConnectError,
  importEd25519PrivateKey,
  SshKeyImportError,
  type Actor,
  type ConnectionService,
  type ImportedFrom,
} from '../connections';
import type { MissionService } from '../missions';
import type {
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
} from '../missions/model';
import type { Store } from '../store';
import type { ConnectionRecord, ConnectionResourceRecord } from '../store/types';
import type { V4Account, V4Bundle, V4Mission, V4Project } from './bundle';
import {
  isPastedKeyProvider,
  pastedKeyFields,
  SSH_PROVIDER,
  sshHostFields,
  STRIPE_PROVIDER,
  stripeKeyFields,
} from './credential-mapping';
import { providerOfV4Risk, translateRisks, type DroppedRisk } from './risk-translation';

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
  /** The single provider list: a v4 provider the instance does not ship is reported. */
  readonly registry: PluginRegistry;
  readonly store: Pick<Store, 'users' | 'groups' | 'connections' | 'missions'>;
  readonly connections: Pick<
    ConnectionService,
    'importPastedKey' | 'importSshKey' | 'updateResource'
  >;
  readonly missions: Pick<MissionService, 'issuanceContext' | 'preview' | 'issue'>;
}

export interface ImportOptions {
  readonly ownerEmail: string;
  /** False: the dry run, nothing is written and no provider is contacted. */
  readonly apply: boolean;
}

/** Refused before anything was read from or written to the instance's domain. */
export class ImportRefused extends Error {
  constructor(
    readonly reason: 'owner-unknown' | 'owner-ambiguous',
    message: string,
  ) {
    super(message);
    this.name = 'ImportRefused';
  }
}

export type ConnectionStatus =
  /** Dry run: would be created at apply. */
  | 'to-create'
  | 'created'
  /** Created by an earlier run (its `imported_from` marker). */
  | 'already-imported'
  /** The owner already holds one with the same non-secret values. */
  | 'already-connected'
  /** The check, the first discovery or the key was refused: nothing stored. */
  | 'failed'
  | 'provider-not-shipped'
  | 'revoked-in-v4';

export interface ConnectionOutcome {
  readonly source: string;
  readonly provider: string;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  readonly connectionId: string | null;
  /** Why it failed, secrets blanked by the caller's redactor. */
  readonly detail: string | null;
}

export interface ByHandOutcome {
  readonly provider: string;
  /** `connected` when the owner already holds an account of it. */
  readonly status: 'to-connect' | 'connected' | 'provider-not-shipped' | 'revoked-in-v4';
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
  readonly provider: string;
  readonly connectionId: string;
  readonly ref: string;
  readonly status: LabelStatus;
  /** The v4 labels it was bound with. */
  readonly v4Labels: readonly string[];
  readonly env: string | null;
}

export interface UnmatchedBinding {
  readonly projectId: string;
  readonly provider: string;
  readonly ref: string;
}

export type MissionStatus =
  | 'would-issue'
  | 'issued'
  | 'exists'
  /** Dry run: depends on a connection still to create. */
  | 'after-connections'
  | 'deferred'
  | 'nothing-to-issue'
  | 'refused';

export interface MissionConnectionPlan {
  readonly provider: string;
  readonly connectionId: string;
  readonly refs: readonly string[];
  readonly riskIds: readonly RiskId[];
}

export interface MissionOutcome {
  readonly project: string;
  readonly tokenName: string;
  readonly name: string;
  readonly status: MissionStatus;
  readonly missionId: string | null;
  readonly connections: readonly MissionConnectionPlan[];
  /** Why the mission waits, or what blocked it (deferred, refused). */
  readonly reasons: readonly string[];
  readonly dropped: readonly (DroppedRisk & { readonly provider: string })[];
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
  readonly connections: readonly ConnectionOutcome[];
  readonly byHand: readonly ByHandOutcome[];
  readonly resources: readonly ResourceOutcome[];
  readonly unmatched: readonly UnmatchedBinding[];
  readonly missions: readonly MissionOutcome[];
  readonly skipped: V4Bundle['skipped'];
  readonly keys: readonly IssuedKey[];
  /** Something the run tried was refused (a connection, a mission). */
  readonly failed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized bundle
// ─────────────────────────────────────────────────────────────────────────────

/** One credential of the bundle that becomes a connection. */
interface Source {
  readonly source: string;
  readonly provider: string;
  readonly displayName: string;
  readonly revokedInV4: boolean;
  /** The non-secret values a hand-made connection is recognised by. */
  readonly visibleFields: Readonly<Record<string, string>>;
  /** The projects bound to it in v4: a mission waits for it in a dry run. */
  readonly projectIds: ReadonlySet<string>;
  readonly create: (actor: Actor) => Promise<{ readonly connection: ConnectionRecord }>;
}

type Matcher =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'stripe-account'; readonly accountId: string };

/** One v4 binding of a project, deduplicated. */
interface Binding {
  readonly projectId: string;
  readonly provider: string;
  readonly matcher: Matcher;
  readonly label: string;
  /** Every non-null v4 label the duplicates carried. */
  readonly v4Labels: readonly string[];
}

function bindingKey(b: Pick<Binding, 'projectId' | 'provider' | 'label'>): string {
  return `${b.projectId}\u0000${b.provider}\u0000${b.label}`;
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
    if (b.provider === STRIPE_PROVIDER || b.provider === SSH_PROVIDER) continue;
    add(
      {
        projectId: b.project_id,
        provider: b.provider,
        matcher: { kind: 'ref', ref: b.resource_ref },
        label: b.resource_ref,
      },
      b.environment,
    );
  }
  for (const account of bundle.stripe_accounts) {
    for (const projectId of account.project_ids) {
      add(
        {
          projectId,
          provider: STRIPE_PROVIDER,
          matcher: { kind: 'stripe-account', accountId: account.account_id },
          label: account.account_id,
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
          provider: SSH_PROVIDER,
          matcher: { kind: 'ref', ref: host.host_address },
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
  resource: Pick<ConnectionResourceRecord, 'ref' | 'metadata'>,
): boolean {
  if (matcher.kind === 'stripe-account') {
    return (
      resource.metadata?.account_id === matcher.accountId ||
      resource.ref.startsWith(`${matcher.accountId}/`)
    );
  }
  return resource.ref === matcher.ref || resource.ref.toLowerCase() === matcher.ref.toLowerCase();
}

function isV5Label(label: string): boolean {
  return (V5_ENV_LABELS as readonly string[]).includes(label);
}

// ─────────────────────────────────────────────────────────────────────────────
// The importer
// ─────────────────────────────────────────────────────────────────────────────

/** A connection the owner may build from, with its resource rows (who set each label). */
interface Held {
  readonly issuance: IssuanceConnection;
  readonly records: readonly ConnectionResourceRecord[];
  readonly importedFromOrg: boolean;
}

export class Importer {
  constructor(private readonly ports: ImporterPorts) {}

  async run(bundle: V4Bundle, options: ImportOptions): Promise<ImportReport> {
    const actor = await this.ownerOf(options.ownerEmail);
    const org = bundle.organization.slug;
    const sources = this.sourcesOf(bundle);

    const connections: ConnectionOutcome[] = [];
    for (const source of sources) {
      connections.push(await this.connect(actor, source, options.apply));
    }
    const byHand = await this.byHand(actor, bundle);

    const bindings = normalizeBindings(bundle);
    const held = await this.held(actor, org);
    const labels = this.planLabels(held, bindings);
    const resources: ResourceOutcome[] = [];
    for (const plan of labels) {
      resources.push(await this.label(actor, plan, options.apply));
    }

    // Missions are planned against the instance as the labels left it.
    const afterLabels = options.apply ? await this.held(actor, org) : withLabels(held, labels);
    const pending = new Set(
      connections.filter((c) => c.status === 'to-create').map((c) => c.source),
    );
    const waiting = sources.filter((s) => pending.has(s.source));
    const missions: MissionOutcome[] = [];
    const keys: IssuedKey[] = [];
    const perProject = countBy(bundle.missions, (m) => m.project_id);
    for (const mission of bundle.missions) {
      const project = bundle.projects.find((p) => p.id === mission.project_id);
      if (!project) continue; // the schema refuses such a bundle
      const name =
        (perProject.get(project.id) ?? 0) > 1
          ? `${project.name} — ${mission.token_name}`
          : project.name;
      const outcome = await this.mission(actor, {
        project,
        mission,
        name,
        bindings: bindings.filter((b) => b.projectId === project.id),
        held: afterLabels,
        waiting,
        apply: options.apply,
      });
      missions.push(outcome.outcome);
      if (outcome.key) keys.push(outcome.key);
    }

    return {
      apply: options.apply,
      org,
      owner: actor.user.email,
      connections,
      byHand,
      resources,
      unmatched: unmatchedOf(bindings, afterLabels, this.ports.registry),
      missions,
      skipped: bundle.skipped,
      keys,
      failed:
        connections.some((c) => c.status === 'failed') ||
        missions.some((m) => m.status === 'refused'),
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

  // ── Connections ───────────────────────────────────────────────────────────

  private importedFrom(bundle: V4Bundle, source: string): ImportedFrom {
    return { system: SYSTEM, org: bundle.organization.slug, source };
  }

  private visibleFieldsOf(
    provider: string,
    kind: 'api-key' | 'ssh-key',
    values: Record<string, string>,
  ) {
    const plugin = this.ports.registry.get(provider)?.plugin;
    const spec = plugin ? credentialSpecFor(plugin, kind) : null;
    const visible: Record<string, string> = {};
    for (const field of spec?.fields ?? []) {
      const value = values[field.name];
      if (!field.secret && value !== undefined) visible[field.name] = value;
    }
    return visible;
  }

  private label4(provider: string): string {
    return this.ports.registry.get(provider)?.plugin.displayName ?? provider;
  }

  private sourcesOf(bundle: V4Bundle): Source[] {
    const org = bundle.organization.slug;
    const sources: Source[] = [];
    const projectsOf = (provider: string) =>
      new Set(bundle.bindings.filter((b) => b.provider === provider).map((b) => b.project_id));

    for (const account of bundle.accounts) {
      const mapped = pastedKeyFields(account);
      if (!mapped.ok) continue;
      const source = `provider_admins/${account.id}`;
      const importedFrom = this.importedFrom(bundle, source);
      const displayName = `${this.label4(account.provider)} (v4 ${org})`;
      sources.push({
        source,
        provider: account.provider,
        displayName,
        revokedInV4: account.status === 'revoked',
        visibleFields: this.visibleFieldsOf(account.provider, 'api-key', mapped.fields),
        projectIds: projectsOf(account.provider),
        create: (actor) =>
          this.ports.connections.importPastedKey(actor, account.provider, {
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
      const displayName = `${this.label4(STRIPE_PROVIDER)} ${account.account_id}`;
      sources.push({
        source,
        provider: STRIPE_PROVIDER,
        displayName,
        revokedInV4: false,
        visibleFields: this.visibleFieldsOf(STRIPE_PROVIDER, 'api-key', fields),
        projectIds: new Set(account.project_ids),
        create: (actor) =>
          this.ports.connections.importPastedKey(actor, STRIPE_PROVIDER, {
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
        provider: SSH_PROVIDER,
        displayName: host.host_slug,
        revokedInV4: false,
        visibleFields: this.visibleFieldsOf(SSH_PROVIDER, 'ssh-key', fields),
        projectIds: new Set(host.project_ids),
        create: (actor) => {
          // Converted here, at apply only: the dry run never touches the key.
          const keyPair = importEd25519PrivateKey(host.private_key, SSH_KEY_COMMENT);
          return this.ports.connections.importSshKey(actor, {
            providerId: SSH_PROVIDER,
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

  private async owned(actor: Actor): Promise<ConnectionRecord[]> {
    const owned = await this.ports.store.connections.listOwnedBy([
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g) => ({ kind: 'group' as const, id: g.id })),
    ]);
    return owned.filter((c) => c.status !== 'revoked');
  }

  private async connect(actor: Actor, source: Source, apply: boolean): Promise<ConnectionOutcome> {
    const outcome = (
      status: ConnectionStatus,
      connectionId: string | null = null,
      detail: string | null = null,
    ): ConnectionOutcome => ({
      source: source.source,
      provider: source.provider,
      displayName: source.displayName,
      status,
      connectionId,
      detail,
    });
    if (!this.ports.registry.has(source.provider)) return outcome('provider-not-shipped');
    if (source.revokedInV4) return outcome('revoked-in-v4');

    const owned = (await this.owned(actor)).filter((c) => c.provider === source.provider);
    const imported = owned.find((c) => importedSourceOf(c) === source.source);
    if (imported) return outcome('already-imported', imported.id);
    const byHand = owned.find((c) =>
      sameVisibleFields(visibleFieldsOfRecord(c), source.visibleFields),
    );
    if (byHand) return outcome('already-connected', byHand.id);
    if (!apply) return outcome('to-create');

    try {
      const created = await source.create(actor);
      return outcome('created', created.connection.id);
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
      if (isPastedKeyProvider(account.provider) && pastedKeyFields(account).ok) continue;
      outcomes.push(this.byHandOf(account, owned));
    }
    return outcomes;
  }

  private byHandOf(account: V4Account, owned: readonly ConnectionRecord[]): ByHandOutcome {
    const provider = account.provider;
    if (!this.ports.registry.has(provider)) {
      return {
        provider,
        status: 'provider-not-shipped',
        reason: 'this instance ships no plugin for it',
      };
    }
    if (account.status === 'revoked') {
      return { provider, status: 'revoked-in-v4', reason: 'the v4 account was revoked' };
    }
    const reason = isPastedKeyProvider(provider)
      ? (pastedKeyFields(account) as { readonly reason: string }).reason
      : account.installation_id !== null
        ? 'a v4 app installation: this instance installs its own app'
        : 'a v4 OAuth grant: sharing its refresh token would break v4 or v5';
    return {
      provider,
      status: owned.some((c) => c.provider === provider) ? 'connected' : 'to-connect',
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
        records: await this.ports.store.connections.listResources(issuance.id),
        importedFromOrg: record !== undefined && importedOrgOf(record) === org,
      });
    }
    return held;
  }

  private planLabels(held: readonly Held[], bindings: readonly Binding[]): LabelPlan[] {
    const perResource = new Map<
      string,
      { held: Held; record: ConnectionResourceRecord; labels: Set<string> }
    >();
    for (const binding of bindings) {
      for (const h of held) {
        if (h.issuance.provider !== binding.provider) continue;
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
        connectionId: h.issuance.id,
        provider: h.issuance.provider,
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
      // Shared with the owner: only the connection's owner labels its resources.
      else if (h.issuance.basis !== 'owner') plans.push(plan('not-owned'));
      else plans.push(plan('to-label', v5[0] ?? null));
    }
    return plans;
  }

  private async label(actor: Actor, plan: LabelPlan, apply: boolean): Promise<ResourceOutcome> {
    const outcome: ResourceOutcome = {
      provider: plan.provider,
      connectionId: plan.connectionId,
      ref: plan.ref,
      status: plan.status,
      v4Labels: plan.v4Labels,
      env: plan.env,
    };
    if (plan.status !== 'to-label' || !apply || plan.env === null) return outcome;
    await this.ports.connections.updateResource(actor, plan.connectionId, plan.resourceId, {
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
      readonly apply: boolean;
    },
  ): Promise<{ readonly outcome: MissionOutcome; readonly key: IssuedKey | null }> {
    const { project, mission, name, bindings, held } = input;
    const base = {
      project: project.name,
      tokenName: mission.token_name,
      name,
      missionId: null,
      connections: [] as MissionConnectionPlan[],
      reasons: [] as string[],
      dropped: [] as (DroppedRisk & { provider: string })[],
      expanded: [] as { v4RiskId: string; v5RiskIds: RiskId[] }[],
      unbound: [] as string[],
    };
    const done = (status: MissionStatus, extra: Partial<MissionOutcome> = {}) => ({
      outcome: { ...base, status, ...extra },
      key: null,
    });

    const existing = (await this.ports.store.missions.listForCreator(actor.user.id)).find(
      (m) => m.name === name && m.status !== 'revoked',
    );
    if (existing) return done('exists', { missionId: existing.id });

    const providers = [...new Set(bindings.map((b) => b.provider))].filter((p) =>
      this.ports.registry.has(p),
    );
    const notShipped = [...new Set(bindings.map((b) => b.provider))].filter(
      (p) => !this.ports.registry.has(p),
    );
    base.reasons.push(...notShipped.map((p) => `${p}: this instance ships no plugin for it`));

    const chosen: { provider: string; held: Held; records: ConnectionResourceRecord[] }[] = [];
    const deferred: string[] = [];
    let waitsForCreation = false;
    for (const provider of providers) {
      const own = bindings.filter((b) => b.provider === provider);
      const best = bestConnection(held, provider, own);
      if (best && best.records.length > 0) {
        chosen.push({ provider, held: best.held, records: best.records });
        continue;
      }
      if (input.waiting.some((s) => s.provider === provider && s.projectIds.has(project.id))) {
        waitsForCreation = true;
        continue;
      }
      const label = this.label4(provider);
      deferred.push(
        held.some((h) => h.issuance.provider === provider)
          ? `${label}: none of the project's resources (${own.map((b) => b.label).join(', ')}) is among the discovered resources of your accounts; refresh their discovery`
          : `${label}: no account connected yet; connect one, then run the import again`,
      );
    }
    if (deferred.length > 0) return done('deferred', { reasons: [...base.reasons, ...deferred] });
    if (waitsForCreation) return done('after-connections');

    const plans: MissionConnectionPlan[] = [];
    const draftConnections: MissionDraft['connections'][number][] = [];
    const inMission = new Set(chosen.map((c) => c.provider));
    base.unbound.push(
      ...mission.accepted_risks.filter((id) => {
        const provider = providerOfV4Risk(id);
        return provider === null || !inMission.has(provider);
      }),
    );
    for (const { provider, held: h, records } of chosen) {
      const selected: IssuanceResource[] = h.issuance.resources.filter((r) =>
        records.some((record) => record.id === r.id),
      );
      const ids = mission.accepted_risks.filter((id) => providerOfV4Risk(id) === provider);
      const translation = translateRisks(ids, h.issuance, selected);
      base.dropped.push(...translation.dropped.map((d) => ({ ...d, provider })));
      base.expanded.push(
        ...translation.expanded.map((e) => ({ v4RiskId: e.v4RiskId, v5RiskIds: [...e.v5RiskIds] })),
      );
      if (translation.entries.length === 0) {
        base.reasons.push(`${this.label4(provider)}: no v4 risk of this service carries over`);
        continue;
      }
      plans.push({
        provider,
        connectionId: h.issuance.id,
        refs: selected.map((r) => r.ref),
        riskIds: translation.entries.map((e) => e.risk_id),
      });
      draftConnections.push({
        connection_id: h.issuance.id,
        resources: { scope: 'selected', resource_ids: selected.map((r) => r.id) },
        preset: null,
        policy: translation.entries.map((e) => ({
          risk_id: e.risk_id,
          quota: e.quota,
          rate_limit: e.rate_limit,
          gate: e.gate,
        })),
      });
    }
    base.connections.push(...plans);
    if (draftConnections.length === 0) return done('nothing-to-issue');

    const draft: MissionDraft = {
      name,
      connections: draftConnections,
      period: { kind: 'recurring', length_seconds: IMPORTED_MISSION_PERIOD_SECONDS },
      expires_at: mission.expires_at,
    };
    const subject = { id: actor.user.id };
    if (!input.apply) {
      const preview = await this.ports.missions.preview(subject, draft);
      return preview.ok
        ? done('would-issue')
        : done('refused', { reasons: [...base.reasons, ...issueLines(preview.issues)] });
    }
    const issued = await this.ports.missions.issue(subject, draft);
    if (!issued.ok) {
      return done('refused', {
        reasons: [
          ...base.reasons,
          ...(issued.reason === 'refused' ? issueLines(issued.preview.issues) : ['not found']),
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
  readonly connectionId: string;
  readonly provider: string;
  readonly resourceId: string;
  readonly ref: string;
  readonly status: LabelStatus;
  readonly v4Labels: readonly string[];
  readonly env: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function importedFromOf(c: Pick<ConnectionRecord, 'metadata'>): Record<string, unknown> | null {
  const marker = c.metadata?.imported_from;
  if (typeof marker !== 'object' || marker === null) return null;
  const record = marker as Record<string, unknown>;
  return record.system === SYSTEM ? record : null;
}

function importedSourceOf(c: Pick<ConnectionRecord, 'metadata'>): string | null {
  const source = importedFromOf(c)?.source;
  return typeof source === 'string' ? source : null;
}

function importedOrgOf(c: Pick<ConnectionRecord, 'metadata'>): string | null {
  const org = importedFromOf(c)?.org;
  return typeof org === 'string' ? org : null;
}

function visibleFieldsOfRecord(c: Pick<ConnectionRecord, 'metadata'>): Record<string, string> {
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
 * least one key and agree on every shared key. A provider whose form has no
 * non-secret value (a Cloudflare token) is never recognised this way.
 */
export function sameVisibleFields(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const shared = Object.keys(a).filter((k) => k in b);
  return shared.length > 0 && shared.every((k) => a[k] === b[k]);
}

function bestConnection(
  held: readonly Held[],
  provider: string,
  bindings: readonly Binding[],
): { readonly held: Held; readonly records: ConnectionResourceRecord[] } | null {
  let best: { held: Held; records: ConnectionResourceRecord[] } | null = null;
  for (const h of held) {
    if (h.issuance.provider !== provider) continue;
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

/** The held connections with the labels the dry run would set. */
function withLabels(held: readonly Held[], plans: readonly LabelPlan[]): Held[] {
  const planned = new Map(
    plans.filter((p) => p.status === 'to-label').map((p) => [p.resourceId, p.env]),
  );
  if (planned.size === 0) return [...held];
  return held.map((h) => ({
    ...h,
    issuance: {
      ...h.issuance,
      resources: h.issuance.resources.map((r) =>
        planned.has(r.id) ? { ...r, env: planned.get(r.id) ?? null } : r,
      ),
    },
    records: h.records.map((r) =>
      planned.has(r.id) ? { ...r, env: planned.get(r.id) ?? null } : r,
    ),
  }));
}

function unmatchedOf(
  bindings: readonly Binding[],
  held: readonly Held[],
  registry: PluginRegistry,
): UnmatchedBinding[] {
  return bindings
    .filter((b) => registry.has(b.provider))
    .filter(
      (b) =>
        !held.some(
          (h) => h.issuance.provider === b.provider && h.records.some((r) => matches(b.matcher, r)),
        ),
    )
    .map((b) => ({ projectId: b.projectId, provider: b.provider, ref: b.label }));
}

function issueLines(issues: readonly PreviewIssue[]): string[] {
  return issues.map((issue) => `${issue.code}: ${issue.message}`);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
