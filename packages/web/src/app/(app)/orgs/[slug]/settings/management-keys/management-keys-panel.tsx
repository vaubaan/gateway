'use client';

import { LocalDate } from '@/components/LocalDate';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  DangerConfirm,
  Field,
  Input,
} from '@/components/ui';

interface ManagementKeyRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_at: string;
}

export function ManagementKeysPanel({
  org,
  initialKeys,
}: {
  org: { id: string; slug: string; name: string };
  initialKeys: ManagementKeyRow[];
}) {
  const router = useRouter();
  const [keys, setKeys] = useState<ManagementKeyRow[]>(initialKeys);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);

  const [confirmKey, setConfirmKey] = useState<ManagementKeyRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${encodeURIComponent(org.slug)}/management-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const json = (await res.json()) as {
        management_key?: ManagementKeyRow;
        api_key?: string;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.management_key) setKeys((cur) => [json.management_key as ManagementKeyRow, ...cur]);
      setFreshApiKey(json.api_key ?? null);
      setNewName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function onDelete(key: ManagementKeyRow) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/v1/orgs/${encodeURIComponent(org.slug)}/management-keys/${encodeURIComponent(key.id)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setKeys((cur) => cur.filter((k) => k.id !== key.id));
      setConfirmKey(null);
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ margin: 0 }}>Management keys</h1>
        <Code>/{org.slug}</Code>
      </header>

      <Banner tone="info">
        Management keys authenticate <strong>programmatic clients</strong> (CI jobs, bootstrap
        scripts, automation) to mint short-lived AccessTokens through{' '}
        <Code>POST /api/v1/mgmt/tokens</Code>. They cannot consume the MCP gateway directly — only
        AccessTokens (<Code>vbn_live_…</Code>) can.
      </Banner>

      {freshApiKey && <FreshKeyCard apiKey={freshApiKey} onDismiss={() => setFreshApiKey(null)} />}

      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <Card>
          <CardHeader>
            <CardTitle>New management key</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={onCreate} style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Field
                label="Name"
                hint="Lowercase kebab-case. Identifies the key in the list and audit views."
              >
                <Input
                  value={newName}
                  onChange={(e) =>
                    setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  pattern="^[a-z0-9](-?[a-z0-9])*$"
                  required
                  placeholder="ci-bootstrap"
                />
              </Field>
              {createError && (
                <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{createError}</p>
              )}
              <div>
                <Button type="submit" variant="primary" disabled={creating || newName.length === 0}>
                  {creating ? 'Creating…' : 'Create management key'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Existing keys</CardTitle>
          </CardHeader>
          <CardBody>
            {keys.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>No management keys yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {keys.map((k) => (
                  <li
                    key={k.id}
                    style={{
                      padding: 'var(--space-3)',
                      borderTop: '1px solid var(--border-subtle)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                    }}
                  >
                    <div>
                      <strong>{k.name}</strong> <Code>vbn_mgmt_{k.api_key_prefix}…</Code>
                      <div
                        style={{
                          fontSize: 'var(--text-sm)',
                          color: 'var(--text-muted)',
                          marginTop: 'var(--space-1)',
                        }}
                      >
                        {k.status === 'active' ? (
                          <span style={{ color: '#16a34a' }}>active</span>
                        ) : (
                          <span style={{ color: '#dc2626' }}>revoked</span>
                        )}
                        {k.last_used_at && (
                          <span style={{ marginLeft: 'var(--space-3)' }}>
                            last used <LocalDate ts={k.last_used_at} />
                          </span>
                        )}
                        <span style={{ marginLeft: 'var(--space-3)' }}>
                          created <LocalDate ts={k.created_at} dateOnly />
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => setConfirmKey(k)}
                      disabled={deleting}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <MgmtSnippetReferenceCard />
      </div>

      {confirmKey && (
        <DangerConfirm
          title={`Delete ${confirmKey.name}?`}
          body={
            <>
              Any client using this management key will start failing immediately. AccessTokens
              already minted with this key remain valid until their <Code>expires_at</Code>. Cannot
              be undone.
            </>
          }
          phrase={confirmKey.name}
          confirmLabel="Delete key"
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setConfirmKey(null);
            setDeleteError(null);
          }}
          onConfirm={() => {
            void onDelete(confirmKey);
          }}
        />
      )}
    </main>
  );
}

function buildMgmtSnippet(apiKey: string, baseUrl: string): string {
  return `# Vaubaan — Management API integration

# 1. Configure
export VAUBAAN_MCP_GATEWAY_BASE_URL="${baseUrl}"
export VAUBAAN_MCP_GATEWAY_MGMT_KEY="${apiKey}"

# 2. Discover projects + bindings
curl -sS "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/projects" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY"

# 3. Mint an ephemeral AccessToken for a coding session, granting just the
#    capabilities it needs (notation provider:plane/level:action[@env]).
#    ttlHours default 24, max 168 (7 days). Response.api_key visible ONCE.
curl -sS -X POST "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/tokens" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "projectSlug": "<slug>", "capabilities": ["github:repo/code:read", "github:repo/code:write@feature/x"], "ttlHours": 24 }'

# 4. Hand the returned api_key (vbn_live_…) to the MCP client:
# {
#   "mcpServers": {
#     "vaubaan": {
#       "url": "${baseUrl}/mcp",
#       "headers": { "Authorization": "Bearer <api_key>" }
#     }
#   }
# }

# 5. After the session, revoke the AccessToken to avoid accumulating rows:
curl -sS -X DELETE "$VAUBAAN_MCP_GATEWAY_BASE_URL/api/v1/mgmt/tokens/<token-id>" \\
  -H "Authorization: Bearer $VAUBAAN_MCP_GATEWAY_MGMT_KEY"

# Full guide: ${baseUrl}/docs/mgmt
`;
}

async function writeClipboard(text: string): Promise<boolean> {
  // Prefer the modern API (secure-context only). Fall back to a textarea +
  // execCommand('copy') trick — old but it still works in non-secure contexts
  // and when navigator.clipboard.writeText rejects (transient focus loss,
  // permission glitches, …).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied!',
  variant = 'primary',
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: 'primary' | 'secondary';
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function onClick() {
    const ok = await writeClipboard(text);
    setState(ok ? 'ok' : 'err');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }
  return (
    <Button
      type="button"
      variant={variant}
      onClick={() => {
        void onClick();
      }}
    >
      {state === 'ok' ? copiedLabel : state === 'err' ? 'Copy failed — select & ⌘C' : label}
    </Button>
  );
}

function FreshKeyCard({ apiKey, onDismiss }: { apiKey: string; onDismiss: () => void }) {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com';
  const snippet = buildMgmtSnippet(apiKey, baseUrl);

  return (
    <Card style={{ marginTop: 'var(--space-4)', borderColor: 'var(--accent-warning-fg)' }}>
      <CardHeader>
        <CardTitle>Copy this management key now</CardTitle>
      </CardHeader>
      <CardBody>
        <p style={{ marginTop: 0, color: 'var(--accent-warning-fg)' }}>
          ⚠️ This is the <strong>only time</strong> the key will be shown. After dismissing this
          panel, only the prefix is retrievable. Lose it = create a new one and revoke this one.
        </p>
        <pre
          style={{
            padding: 'var(--space-3)',
            background: 'var(--surface-base)',
            borderRadius: 'var(--radius-md)',
            overflow: 'auto',
            fontSize: 'var(--text-sm)',
            margin: 0,
          }}
        >
          {apiKey}
        </pre>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
          <CopyButton text={apiKey} label="Copy key" />
          <Button type="button" variant="secondary" onClick={onDismiss}>
            I&apos;ve copied it — dismiss
          </Button>
        </div>

        <details style={{ marginTop: 'var(--space-4)' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontWeight: 600,
              padding: 'var(--space-2) 0',
            }}
          >
            Setup snippet — paste this into your other project for an LLM/agent to scaffold the
            integration
          </summary>
          <p style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
            Drops the full discovery + mint flow with your key already inlined. Full guide:{' '}
            <a href="/docs/mgmt" target="_blank" rel="noreferrer">
              /docs/mgmt
            </a>
            .
          </p>
          <pre
            style={{
              padding: 'var(--space-3)',
              background: 'var(--surface-base)',
              borderRadius: 'var(--radius-md)',
              overflow: 'auto',
              fontSize: 'var(--text-xs)',
              maxHeight: 320,
              margin: 0,
              whiteSpace: 'pre',
            }}
          >
            {snippet}
          </pre>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyButton text={snippet} label="Copy snippet" />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

/**
 * Always-visible card: same management API snippet as the fresh-key card, but
 * with a placeholder where the key would go. Lives at the bottom of the
 * management-keys panel so an operator can grab the integration script anytime
 * — long after the original key was dismissed.
 */
function MgmtSnippetReferenceCard() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com';
  const snippet = buildMgmtSnippet('<paste-your-mgmt-key>', baseUrl);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Management API setup snippet</CardTitle>
      </CardHeader>
      <CardBody>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Paste this into your other project for an LLM/agent to scaffold the integration. Replace{' '}
          <Code>&lt;paste-your-mgmt-key&gt;</Code> with one of the active keys above — the full key
          is only visible at creation time, so keep yours safe.
        </p>
        <pre
          style={{
            padding: 'var(--space-3)',
            background: 'var(--surface-base)',
            borderRadius: 'var(--radius-md)',
            overflow: 'auto',
            fontSize: 'var(--text-xs)',
            maxHeight: 320,
            margin: 0,
            whiteSpace: 'pre',
          }}
        >
          {snippet}
        </pre>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <CopyButton text={snippet} label="Copy snippet" />
        </div>
      </CardBody>
    </Card>
  );
}
