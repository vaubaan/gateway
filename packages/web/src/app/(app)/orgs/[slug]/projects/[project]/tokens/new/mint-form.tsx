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
 * The form orchestrates state ; the row-level UI is decomposed across
 * sibling files in this folder :
 *   - mint-types.ts          : shared interfaces + tone tables
 *   - vector-row.tsx         : 6D vector badges
 *   - risk-row.tsx           : one checkbox + collapsible row
 *   - binding-risks-section.tsx : risks for one binding
 *   - provider-risks-card.tsx   : Card grouping bindings of one provider
 *   - preview-footer.tsx     : sticky live counts + action button
 *   - mint-result-dialog.tsx : post-mint modal
 *   - qualify-helpers.ts     : adapt local entry shape to policy-engine
 *
 * Style is intentionally inline + `var(--…)` to match the project's
 * existing pages (no shadcn-style component layer is in use here).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Provider, RiskId } from '@vaubaan/shared';

import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';

import {
  type MintFormBinding,
  type MintFormCatalog,
  type MintResult,
  type PreviewResponse,
  type PreviewRiskRow,
} from './mint-types';
import { MintResultDialog } from './mint-result-dialog';
import { PreviewFooter } from './preview-footer';
import { ProviderRisksCard } from './provider-risks-card';

// Re-export public shapes consumed by page.tsx — preserves the existing
// `import { MintForm, type MintFormBinding, type MintFormCatalog } from './mint-form'`
// contract.
export type { MintFormBinding, MintFormCatalog, MintFormCatalogEntry } from './mint-types';

/** TTL presets — matches the spec's "short / session / long" buckets. */
const TTL_OPTIONS = [
  { value: '600', label: 'short (10 min)' },
  { value: '3600', label: 'session (1 h)' },
  { value: '86400', label: 'long (24 h)' },
] as const;

type TtlValue = (typeof TTL_OPTIONS)[number]['value'];

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
