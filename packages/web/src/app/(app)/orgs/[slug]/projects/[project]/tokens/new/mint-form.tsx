'use client';

/**
 * Token-mint form — risk-checklist UI.
 *
 * Spec : docs/spec/gateway-risk-model.md §9 + annexe A.
 *
 * Responsibilities :
 *  - render one card per (provider × env) binding, with the applicable
 *    risks below as a checklist. Per spec §4.4, a risk whose
 *    `acceptable_in_envs` doesn't contain the binding env is hidden ;
 *    risks `default_gate === 'deny'` are shown greyed-out + disabled
 *    (cf. ADR D6).
 *  - call POST /api/v1/projects/:projectId/mint/preview on every change
 *    (300 ms debounce) so the manager sees the live effective gate
 *    (which can be tighter than `default_gate` if a project policy
 *    override exists). The footer surfaces the count of allow / confirm
 *    / deny + a primary action button.
 *  - on click, call POST /api/v1/projects/:projectId/mint and surface :
 *      201 → modal with the plaintext api_key (one-time);
 *      202 → message + link to /approvals;
 *      403 → list of denied risks;
 *      5xx → message + the response detail when available.
 *
 * Style is intentionally inline + `var(--…)` to match the project's
 * existing pages (no shadcn-style component layer is in use here).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { Provider, RiskEntry, RiskGate, RiskId, RiskVector } from '@vaubaan/shared';
import { qualifyRiskId } from '@vaubaan/policy-engine';

import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
} from '@/components/ui';

// ─── Public shapes (consumed by page.tsx) ───────────────────────────────────

export interface MintFormBinding {
  provider: Provider;
  /** e.g. `sbw-vaubaan/gateway`, `prj_xyz`, `vps-1` (host slug for bash). */
  resource_ref: string;
  /** The env qualifier ; null for account-scope bindings (github / vercel team / bash hosts). */
  env: string | null;
  display_name: string;
}

export interface MintFormCatalogEntry {
  id: RiskId;
  label: string;
  reason: string;
  vector: RiskVector;
  default_gate: RiskGate;
  acceptable_in_envs: readonly string[] | null;
  deprecated: boolean;
}

export interface MintFormCatalog {
  provider: Provider;
  loaded: boolean;
  entries: MintFormCatalogEntry[];
}

// ─── Internal types ─────────────────────────────────────────────────────────

/** Server-side preview row (mirrors `PreviewRiskRow` on the wire). */
interface PreviewRiskRow {
  id: RiskId;
  base_id: RiskId;
  provider: Provider;
  env: string | null;
  label: string;
  reason: string;
  vector: RiskVector | null;
  effective_gate: RiskGate;
  origin: 'catalog-default' | 'project-policy-env-scoped' | 'project-policy-global';
  blocked_reason?: string;
}

interface PreviewResponse {
  risks: PreviewRiskRow[];
  all_allowed: boolean;
  needs_approval: RiskId[];
  denied: RiskId[];
}

/** TTL presets — matches the spec's "short / session / long" buckets. */
const TTL_OPTIONS = [
  { value: '600', label: 'short (10 min)' },
  { value: '3600', label: 'session (1 h)' },
  { value: '86400', label: 'long (24 h)' },
] as const;

type TtlValue = (typeof TTL_OPTIONS)[number]['value'];

const GATE_TONE: Record<RiskGate, BadgeTone> = {
  allow: 'success',
  confirm: 'warning',
  deny: 'danger',
};

/** Sort risks within a binding card : allow > confirm > deny so the deniable
 *  rows sink to the bottom. */
const GATE_ORDER: Record<RiskGate, number> = { allow: 0, confirm: 1, deny: 2 };

interface MintSuccessResult {
  kind: 'minted';
  apiKey: string;
  tokenName: string;
  expiresAt: string;
}

interface MintPendingResult {
  kind: 'pending';
  approvalId: string;
  channel: string;
  expiresAt: string;
}

interface MintDeniedResult {
  kind: 'denied';
  risks: PreviewRiskRow[];
}

interface MintErrorResult {
  kind: 'error';
  message: string;
}

type MintResult = MintSuccessResult | MintPendingResult | MintDeniedResult | MintErrorResult;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Predicate: "is this catalog entry applicable to this binding env ?" */
function entryAppliesToBinding(entry: MintFormCatalogEntry, env: string | null): boolean {
  if (entry.deprecated) return false;
  if (!entry.acceptable_in_envs || entry.acceptable_in_envs.length === 0) return true;
  if (env === null) return false;
  return entry.acceptable_in_envs.includes(env);
}

/** Group bindings by provider — preserves the in-array order for stable rendering. */
function groupBindings(bindings: readonly MintFormBinding[]): Map<Provider, MintFormBinding[]> {
  const groups = new Map<Provider, MintFormBinding[]>();
  for (const b of bindings) {
    let arr = groups.get(b.provider);
    if (!arr) {
      arr = [];
      groups.set(b.provider, arr);
    }
    arr.push(b);
  }
  return groups;
}

/** Cast the local catalog entry (shaped for the page contract) into the
 *  policy-engine `RiskEntry` shape consumed by `qualifyRiskId`. The shapes
 *  align on the `acceptable_in_envs` field, which is the only one
 *  `qualifyRiskId` reads. */
function asRiskEntry(entry: MintFormCatalogEntry): RiskEntry {
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    matches: '',
    vector: entry.vector,
    default_gate: entry.default_gate,
    acceptable_in_envs: entry.acceptable_in_envs ?? undefined,
  };
}

// ─── Component ─────────────────────────────────────────────────────────────

export function MintForm({
  orgSlug,
  projectSlug,
  projectId,
  bindings,
  catalogs,
}: {
  orgSlug: string;
  projectSlug: string;
  projectId: string;
  bindings: MintFormBinding[];
  catalogs: MintFormCatalog[];
}) {
  const router = useRouter();
  const [tokenName, setTokenName] = useState('');
  const [ttl, setTtl] = useState<TtlValue>('3600');
  const [singleUse, setSingleUse] = useState(false);
  /** Set of qualified RiskId the manager wants to ACCEPT. We track the
   *  qualified form (e.g. `supabase[staging].bulk-row-write`) so the same
   *  base risk can be selected for one env and not another. */
  const [accepted, setAccepted] = useState<Set<RiskId>>(new Set());
  const [previewState, setPreviewState] = useState<'idle' | 'computing' | 'ready' | 'error'>(
    'idle',
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [isMinting, startMint] = useTransition();

  const groupedBindings = useMemo(() => groupBindings(bindings), [bindings]);
  const acceptedArray = useMemo(() => Array.from(accepted), [accepted]);
  const bindingsBody = useMemo(
    () =>
      bindings.map((b) => ({
        provider: b.provider,
        resource_ref: b.resource_ref,
        env: b.env,
      })),
    [bindings],
  );

  // Build the wire `accepted_risks` array. Each item is the QUALIFIED
  // RiskId — the server unqualifies internally to look up the catalog
  // entry. We dedupe to handle the rare case of two bindings sharing
  // the same env.
  const wireAcceptedRisks = useMemo(() => Array.from(new Set(acceptedArray)), [acceptedArray]);

  // ── Debounced preview fetch ─────────────────────────────────────────────
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (wireAcceptedRisks.length === 0) {
      setPreview(null);
      setPreviewState('idle');
      return;
    }
    const reqId = ++reqIdRef.current;
    setPreviewState('computing');
    const runPreview = async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/mint/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            orgSlug,
            bindings: bindingsBody,
            accepted_risks: wireAcceptedRisks,
          }),
        });
        const json = (await res.json()) as PreviewResponse & { error?: string };
        if (reqId !== reqIdRef.current) return;
        if (!res.ok) {
          setPreviewState('error');
          setPreviewError(json.error ?? `HTTP ${res.status}`);
          setPreview(null);
          return;
        }
        setPreview(json);
        setPreviewState('ready');
        setPreviewError(null);
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        setPreviewState('error');
        setPreviewError(e instanceof Error ? e.message : String(e));
        setPreview(null);
      }
    };
    const handle = window.setTimeout(() => {
      void runPreview();
    }, 300);
    return () => window.clearTimeout(handle);
  }, [projectId, orgSlug, bindingsBody, wireAcceptedRisks]);

  // Effective gate by QUALIFIED id (from latest preview) → drives row badges +
  // the "blocked by policy" UX for entries the project policy denies.
  const effectiveGates = useMemo(() => {
    const map = new Map<RiskId, PreviewRiskRow>();
    if (preview) {
      for (const row of preview.risks) map.set(row.id, row);
    }
    return map;
  }, [preview]);

  // ── Toggle handler ──────────────────────────────────────────────────────
  const toggleRisk = useCallback((qualifiedId: RiskId) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(qualifiedId)) next.delete(qualifiedId);
      else next.add(qualifiedId);
      return next;
    });
    setMintResult(null);
  }, []);

  // ── Mint action ─────────────────────────────────────────────────────────
  const onMint = useCallback(() => {
    setMintResult(null);
    startMint(async () => {
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/mint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            orgSlug,
            bindings: bindingsBody,
            accepted_risks: wireAcceptedRisks,
            ttlSeconds: Number(ttl),
            singleUse,
            ...(tokenName.length > 0 ? { name: tokenName } : {}),
          }),
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (res.status === 201) {
          setMintResult({
            kind: 'minted',
            apiKey: String(json.api_key),
            tokenName:
              (json.access_token as { name?: string } | undefined)?.name ?? tokenName ?? '',
            expiresAt: String(json.expires_at ?? ''),
          });
          return;
        }
        if (res.status === 202) {
          setMintResult({
            kind: 'pending',
            approvalId: String(json.approval_id),
            channel: String(json.channel ?? ''),
            expiresAt: String(json.expires_at ?? ''),
          });
          return;
        }
        if (res.status === 403) {
          setMintResult({
            kind: 'denied',
            risks: (json.risks as PreviewRiskRow[]) ?? [],
          });
          return;
        }
        setMintResult({
          kind: 'error',
          message:
            (json.error as string | undefined) ??
            (json.detail as string | undefined) ??
            `HTTP ${res.status}`,
        });
      } catch (e) {
        setMintResult({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }, [projectId, orgSlug, bindingsBody, wireAcceptedRisks, ttl, singleUse, tokenName]);

  // ── Render ──────────────────────────────────────────────────────────────
  const allowCount = preview?.risks.filter((r) => r.effective_gate === 'allow').length ?? 0;
  const confirmCount = preview?.needs_approval.length ?? 0;
  const denyCount = preview?.denied.length ?? 0;
  const canMint =
    accepted.size > 0 &&
    previewState === 'ready' &&
    preview !== null &&
    denyCount === 0 &&
    !isMinting;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', paddingBottom: 'var(--space-8)' }}>
      <Card>
        <CardHeader>
          <CardTitle>Token settings</CardTitle>
        </CardHeader>
        <CardBody>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(220px, 1fr) auto auto',
              gap: 'var(--space-3)',
              alignItems: 'end',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                Token name (optional)
              </span>
              <input
                type="text"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder={'e.g. "feature-x-coding-session"'}
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-base)',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--text-sm)',
                }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>TTL</span>
              <select
                value={ttl}
                onChange={(e) => setTtl(e.target.value as TtlValue)}
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-base)',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--text-sm)',
              }}
            >
              <input
                type="checkbox"
                checked={singleUse}
                onChange={(e) => setSingleUse(e.target.checked)}
              />
              single-use
            </label>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bindings ({bindings.length})</CardTitle>
        </CardHeader>
        <CardBody>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            {bindings.map((b) => (
              <li
                key={`${b.provider}-${b.resource_ref}-${b.env ?? ''}`}
                style={{
                  display: 'inline-flex',
                  gap: 6,
                  alignItems: 'center',
                  padding: '4px 8px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-elevated)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <Badge tone="neutral">{b.provider}</Badge>
                {b.env && <Code>{b.env}</Code>}
                <span style={{ color: 'var(--text-muted)' }}>{b.display_name}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {Array.from(groupedBindings.entries()).map(([provider, providerBindings]) => {
        const cat = catalogs.find((c) => c.provider === provider);
        return (
          <ProviderRisksCard
            key={provider}
            provider={provider}
            providerBindings={providerBindings}
            catalog={cat}
            accepted={accepted}
            effectiveGates={effectiveGates}
            onToggle={toggleRisk}
          />
        );
      })}

      <PreviewFooter
        allowCount={allowCount}
        confirmCount={confirmCount}
        denyCount={denyCount}
        previewState={previewState}
        previewError={previewError}
        acceptedCount={accepted.size}
        canMint={canMint}
        isMinting={isMinting}
        onMint={onMint}
      />

      {mintResult && (
        <MintResultDialog
          result={mintResult}
          onClose={() => {
            setMintResult(null);
            if (mintResult.kind === 'minted' || mintResult.kind === 'pending') {
              router.push(
                mintResult.kind === 'pending'
                  ? `/orgs/${orgSlug}/projects/${projectSlug}/approvals`
                  : `/orgs/${orgSlug}/projects/${projectSlug}/tokens`,
              );
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Provider risks card ────────────────────────────────────────────────────

function ProviderRisksCard({
  provider,
  providerBindings,
  catalog,
  accepted,
  effectiveGates,
  onToggle,
}: {
  provider: Provider;
  providerBindings: MintFormBinding[];
  catalog: MintFormCatalog | undefined;
  accepted: Set<RiskId>;
  effectiveGates: Map<RiskId, PreviewRiskRow>;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  if (!catalog || !catalog.loaded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{provider}</CardTitle>
          <Badge tone="danger">catalog not loaded</Badge>
        </CardHeader>
        <CardBody>
          <p style={{ margin: 0, color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
            Risk catalog for <Code>{provider}</Code> is unavailable — re-mint from this provider is
            blocked until it loads.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {provider} ({providerBindings.length} binding{providerBindings.length === 1 ? '' : 's'})
        </CardTitle>
      </CardHeader>
      <CardBody>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          {providerBindings.map((binding) => (
            <BindingRisksSection
              key={`${provider}-${binding.resource_ref}-${binding.env ?? ''}`}
              binding={binding}
              catalog={catalog}
              accepted={accepted}
              effectiveGates={effectiveGates}
              onToggle={onToggle}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function BindingRisksSection({
  binding,
  catalog,
  accepted,
  effectiveGates,
  onToggle,
}: {
  binding: MintFormBinding;
  catalog: MintFormCatalog;
  accepted: Set<RiskId>;
  effectiveGates: Map<RiskId, PreviewRiskRow>;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  const applicableEntries = catalog.entries.filter((e) => entryAppliesToBinding(e, binding.env));

  // Sort by effective_gate (allow > confirm > deny). The effective gate
  // comes from the live preview when the risk is currently accepted, else
  // we fall back to `default_gate`.
  const rows = applicableEntries
    .map((entry) => {
      const qualifiedId = qualifyRiskId(entry.id, binding.env, asRiskEntry(entry));
      const isAccepted = accepted.has(qualifiedId);
      const previewRow = effectiveGates.get(qualifiedId);
      const effective: RiskGate = previewRow?.effective_gate ?? entry.default_gate;
      const blocked = previewRow?.blocked_reason ?? null;
      // A risk is policy-blocked if effective_gate === 'deny' AND the
      // entry isn't deny by default (i.e. the project policy is the
      // tightening source).
      const lockedByPolicy =
        effective === 'deny' && entry.default_gate !== 'deny' && previewRow !== undefined;
      return { entry, qualifiedId, isAccepted, effective, blocked, lockedByPolicy };
    })
    .sort((a, b) => {
      const diff = GATE_ORDER[a.effective] - GATE_ORDER[b.effective];
      if (diff !== 0) return diff;
      return a.entry.id.localeCompare(b.entry.id);
    });

  return (
    <div>
      <div
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-2)',
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>{binding.display_name}</strong>
        {binding.env && <Code>{binding.env}</Code>}
      </div>
      {rows.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--text-subtle)',
            fontSize: 'var(--text-sm)',
          }}
        >
          No catalog entries apply to this binding env.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <RiskRow
              key={row.qualifiedId}
              entry={row.entry}
              qualifiedId={row.qualifiedId}
              isAccepted={row.isAccepted}
              effective={row.effective}
              blocked={row.blocked}
              lockedByPolicy={row.lockedByPolicy || row.entry.default_gate === 'deny'}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RiskRow({
  entry,
  qualifiedId,
  isAccepted,
  effective,
  blocked,
  lockedByPolicy,
  onToggle,
}: {
  entry: MintFormCatalogEntry;
  qualifiedId: RiskId;
  isAccepted: boolean;
  effective: RiskGate;
  blocked: string | null;
  lockedByPolicy: boolean;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const disabled = lockedByPolicy;
  const opacity = disabled ? 0.45 : 1;
  const tooltip = disabled ? (blocked ?? 'Blocked by project policy') : entry.reason;

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 'var(--space-2) 0',
        borderBottom: '1px solid var(--border-subtle)',
        opacity,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={isAccepted}
          disabled={disabled}
          onChange={() => onToggle(qualifiedId)}
          style={{ marginTop: 4, cursor: disabled ? 'not-allowed' : 'pointer' }}
          aria-label={`Accept risk ${qualifiedId}`}
          title={tooltip}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Code>{qualifiedId}</Code>
            <Badge tone={GATE_TONE[effective]}>{effective}</Badge>
            {lockedByPolicy && (
              <span title={tooltip}>
                <Badge tone="neutral">blocked by policy</Badge>
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {expanded ? 'hide details ▴' : 'details ▾'}
            </button>
          </div>
          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
              marginTop: 2,
            }}
          >
            {entry.label}
          </div>
          {expanded && (
            <div
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
                marginTop: 6,
                padding: 'var(--space-2)',
                background: 'var(--surface-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ marginBottom: 6 }}>{entry.reason}</div>
              <VectorRow vector={entry.vector} />
              {blocked && (
                <div
                  style={{
                    marginTop: 6,
                    color: 'var(--accent-danger-fg)',
                  }}
                >
                  {blocked}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── 6D vector mini-badges (same logic as the provider info page) ──────────

function VectorRow({ vector }: { vector: RiskVector }) {
  const axes: Array<{ key: string; value: string; tone: BadgeTone }> = [
    { key: 'rev', value: vector.reversibility, tone: reversibilityTone(vector.reversibility) },
    { key: 'blast', value: vector.blast, tone: blastTone(vector.blast) },
    { key: 'data', value: vector.data, tone: dataTone(vector.data) },
    { key: 'cost', value: vector.cost, tone: costTone(vector.cost) },
    { key: 'vis', value: vector.visibility, tone: visibilityTone(vector.visibility) },
    { key: 'pers', value: vector.persistence, tone: persistenceTone(vector.persistence) },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {axes.map((axis) => (
        <Badge key={axis.key} tone={axis.tone}>
          <span style={{ opacity: 0.6, fontSize: '0.85em' }}>{axis.key}:</span> {axis.value}
        </Badge>
      ))}
    </div>
  );
}

function reversibilityTone(v: RiskVector['reversibility']): BadgeTone {
  if (v === 'reversible') return 'success';
  if (v === 'costly') return 'warning';
  return 'danger';
}
function blastTone(v: RiskVector['blast']): BadgeTone {
  if (v === 'single') return 'success';
  if (v === 'env') return 'info';
  if (v === 'account') return 'warning';
  return 'danger';
}
function dataTone(v: RiskVector['data']): BadgeTone {
  if (v === 'metadata') return 'neutral';
  if (v === 'data') return 'info';
  return 'danger';
}
function costTone(v: RiskVector['cost']): BadgeTone {
  if (v === 'free') return 'success';
  if (v === 'moderate') return 'warning';
  return 'danger';
}
function visibilityTone(v: RiskVector['visibility']): BadgeTone {
  if (v === 'internal') return 'success';
  if (v === 'team') return 'info';
  return 'danger';
}
function persistenceTone(v: RiskVector['persistence']): BadgeTone {
  if (v === 'stateless') return 'success';
  if (v === 'session') return 'info';
  return 'warning';
}

// ─── Sticky footer ──────────────────────────────────────────────────────────

function PreviewFooter({
  allowCount,
  confirmCount,
  denyCount,
  previewState,
  previewError,
  acceptedCount,
  canMint,
  isMinting,
  onMint,
}: {
  allowCount: number;
  confirmCount: number;
  denyCount: number;
  previewState: 'idle' | 'computing' | 'ready' | 'error';
  previewError: string | null;
  acceptedCount: number;
  canMint: boolean;
  isMinting: boolean;
  onMint: () => void;
}) {
  const buttonLabel = isMinting
    ? 'Minting…'
    : confirmCount > 0
      ? `Request approval (${confirmCount} confirm)`
      : 'Mint token';

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        boxShadow: '0 -4px 12px rgba(0,0,0,0.08)',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        {previewState === 'idle' && acceptedCount === 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Pick at least one risk to enable mint.
          </span>
        )}
        {previewState === 'computing' && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Computing preview…
          </span>
        )}
        {previewState === 'error' && (
          <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
            Preview error : {previewError}
          </span>
        )}
        {previewState === 'ready' && (
          <>
            <span>
              <Badge tone="success">{allowCount} allow</Badge>
            </span>
            <span>
              <Badge tone="warning">{confirmCount} confirm</Badge>
            </span>
            <span>
              <Badge tone="danger">{denyCount} deny</Badge>
            </span>
          </>
        )}
      </div>
      <Button variant="primary" disabled={!canMint} onClick={onMint}>
        {buttonLabel}
      </Button>
    </div>
  );
}

// ─── Mint result dialog ─────────────────────────────────────────────────────

function MintResultDialog({ result, onClose }: { result: MintResult; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 'var(--space-4)',
      }}
    >
      <div
        style={{
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-5)',
          maxWidth: 640,
          width: '100%',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        {result.kind === 'minted' && (
          <>
            <h2 style={{ margin: 0 }}>Token minted</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Copy the api_key below — it is shown <strong>once</strong>. Closing this dialog clears
              it from memory and there is no way to retrieve it again.
            </p>
            <pre
              style={{
                padding: 'var(--space-3)',
                background: 'var(--surface-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                overflowX: 'auto',
                userSelect: 'all',
              }}
            >
              {result.apiKey}
            </pre>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Expires : <Code>{result.expiresAt}</Code>
            </p>
            <Button variant="primary" onClick={onClose}>
              I&apos;ve copied it — close
            </Button>
          </>
        )}
        {result.kind === 'pending' && (
          <>
            <h2 style={{ margin: 0 }}>Approval requested</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Some risks need a human approval. A notification was dispatched via{' '}
              <Code>{result.channel}</Code>. Once approved, the api_key will be available to whoever
              polls the approval. Expires : <Code>{result.expiresAt}</Code>.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Link href="approvals">
                <Button variant="primary" onClick={onClose}>
                  See pending approvals
                </Button>
              </Link>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
        {result.kind === 'denied' && (
          <>
            <h2 style={{ margin: 0 }}>Mint denied</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              At least one accepted risk is denied by the project policy or the catalog. Untick the
              rows below and retry, or ask the project owner to relax the policy.
            </p>
            <ul style={{ paddingLeft: 18, fontSize: 13 }}>
              {result.risks.map((r) => (
                <li key={r.id}>
                  <Code>{r.id}</Code>{' '}
                  <span style={{ color: 'var(--text-muted)' }}>
                    — {r.blocked_reason ?? 'denied by policy'}
                  </span>
                </li>
              ))}
            </ul>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )}
        {result.kind === 'error' && (
          <>
            <h2 style={{ margin: 0 }}>Mint failed</h2>
            <p style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
              {result.message}
            </p>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
