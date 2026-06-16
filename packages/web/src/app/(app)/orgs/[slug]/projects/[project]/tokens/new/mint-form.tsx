'use client';

/**
 * Token-mint form — risk-checklist UI.
 *
 * Post drop-confirm : single flat checklist per binding, each row carries
 * `{ acceptable, inherited }`. A row is mintable iff both are true ;
 * disabled otherwise with a tooltip explaining why.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * Responsibilities :
 *  - render one card per (provider × env) binding, with the applicable
 *    risks below as a checklist;
 *  - call POST /api/v1/tokens/preview on every change (300 ms debounce)
 *    so the manager sees which rows are acceptable / inherited;
 *  - on click, call POST /api/v1/tokens/mint and surface :
 *      201 → modal with the plaintext api_key (one-time);
 *      403 → list of not-acceptable / not-inherited risks;
 *      5xx → response `error` message verbatim.
 *
 * Auth : both endpoints accept the user's Supabase session via the
 * `allowSessionFallback` opt-in on `requireToken` (cf.
 * lib/auth/require-token.ts). No Bearer is sent from the browser.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Provider, RiskId } from '@vaubaan/shared';

import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { TOKEN_NAME_REGEX } from '@/lib/mint/token-name';

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

// Re-export public shapes consumed by page.tsx.
export type { MintFormBinding, MintFormCatalog, MintFormCatalogEntry } from './mint-types';

/**
 * TTL presets — matches the spec's "short / session / long" buckets.
 *
 * The mint route accepts either `ttlHours` (any TTL up to a week) OR
 * `ttlSeconds` paired with `singleUse: true` (cf. tokens/mint/route.ts §65 :
 * sub-hour TTLs are constrained to single-use to avoid leaving sticky-state
 * dust on the gateway). We map each preset to the right body fields.
 */
const TTL_OPTIONS = [
  { value: '600', label: 'short (10 min, single-use)' },
  { value: '3600', label: 'session (1 h)' },
  { value: '86400', label: 'long (24 h)' },
] as const;

type TtlValue = (typeof TTL_OPTIONS)[number]['value'];

interface TtlBodyFields {
  ttlHours?: number;
  ttlSeconds?: number;
  singleUse?: boolean;
}

/** Shape returned by `POST /api/v1/tokens/mint` on 201. Mirrors
 *  `route.ts` lines 230-237 (token row + plaintext api_key + expiry +
 *  echo of the accepted_risks). Kept local — the wire shape lives at
 *  the route boundary, not in `@vaubaan/shared`. */
interface MintSuccessBody {
  token: { id: string; name: string; api_key_prefix: string };
  api_key: string;
  expires_at: string;
  accepted_risks: RiskId[];
}

/** Convert a TTL preset into the body fields the mint route expects. The
 *  "short" preset enforces single-use (the route rejects ttlSeconds without
 *  it) ; longer buckets are free to be single-use or reusable. */
function ttlPresetToBody(ttl: TtlValue, singleUseExplicit: boolean): TtlBodyFields {
  const seconds = Number(ttl);
  if (seconds < 3600) {
    // Sub-hour bucket : the route refuses ttlSeconds unless singleUse=true.
    return { ttlSeconds: seconds, singleUse: true };
  }
  // 1h+ buckets : convert to ttlHours so the body stays singleUse-agnostic.
  return { ttlHours: Math.round(seconds / 3600), singleUse: singleUseExplicit };
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
        const res = await fetch(`/api/v1/tokens/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
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
  }, [projectId, bindingsBody, wireAcceptedRisks]);

  // Index preview rows by qualified id for the per-row RiskRow lookup.
  const previewByRiskId = useMemo(() => {
    const map = new Map<RiskId, PreviewRiskRow>();
    if (preview) {
      for (const row of preview.risks) map.set(row.id, row);
    }
    return map;
  }, [preview]);

  // Client-side validation of the optional token name — the mint route
  // enforces `TOKEN_NAME_REGEX` and 400s on mismatch. Catch it before posting.
  const tokenNameInvalid = tokenName.length > 0 && !TOKEN_NAME_REGEX.test(tokenName);

  const toggleRisk = useCallback((qualifiedId: RiskId) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(qualifiedId)) next.delete(qualifiedId);
      else next.add(qualifiedId);
      return next;
    });
    setMintResult(null);
  }, []);

  const onMint = useCallback(() => {
    setMintResult(null);
    startMint(async () => {
      try {
        // The unified mint route (cf. tokens/mint/route.ts) requires
        // `scope` + `projectId|projectSlug`. TTL goes via `ttlSeconds` (the
        // route accepts it only when `singleUse: true` ; we mirror that
        // pairing here — the UI session bucket is "short single-use" by
        // construction).
        const res = await fetch(`/api/v1/tokens/mint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: 'project',
            projectId,
            bindings: bindingsBody,
            accepted_risks: wireAcceptedRisks,
            ...ttlPresetToBody(ttl, singleUse),
            ...(tokenName.length > 0 ? { name: tokenName } : {}),
          }),
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (res.status === 201) {
          const body = json as unknown as MintSuccessBody;
          setMintResult({
            kind: 'minted',
            apiKey: body.api_key,
            tokenName: body.token?.name ?? tokenName ?? '',
            expiresAt: body.expires_at ?? '',
          });
          return;
        }
        if (res.status === 403) {
          setMintResult({
            kind: 'denied',
            risks: (json.risks as PreviewRiskRow[]) ?? [],
            notAcceptable: (json.not_acceptable as RiskId[]) ?? [],
            notInherited: (json.not_inherited as RiskId[]) ?? [],
          });
          return;
        }
        setMintResult({
          kind: 'error',
          message: (json.error as string | undefined) ?? `HTTP ${res.status}`,
        });
      } catch (e) {
        setMintResult({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }, [projectId, bindingsBody, wireAcceptedRisks, ttl, singleUse, tokenName]);

  const acceptableCount = preview?.risks.filter((r) => r.acceptable && r.inherited).length ?? 0;
  const notAcceptableCount = preview?.not_acceptable.length ?? 0;
  const notInheritedCount = preview?.not_inherited.length ?? 0;
  const canMint =
    accepted.size > 0 &&
    previewState === 'ready' &&
    preview !== null &&
    preview.ok &&
    !isMinting &&
    !tokenNameInvalid;

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
                  border: `1px solid ${
                    tokenNameInvalid ? 'var(--accent-danger-fg)' : 'var(--border-subtle)'
                  }`,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-base)',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--text-sm)',
                }}
              />
              {tokenNameInvalid && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-danger-fg)' }}>
                  must match {TOKEN_NAME_REGEX.source} (lowercase kebab-case)
                </span>
              )}
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
                  background: 'var(--surface-raised)',
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
            previewByRiskId={previewByRiskId}
            onToggle={toggleRisk}
          />
        );
      })}

      <PreviewFooter
        acceptableCount={acceptableCount}
        notAcceptableCount={notAcceptableCount}
        notInheritedCount={notInheritedCount}
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
            if (mintResult.kind === 'minted') {
              router.push(`/orgs/${orgSlug}/projects/${projectSlug}/tokens`);
            }
          }}
        />
      )}
    </div>
  );
}
