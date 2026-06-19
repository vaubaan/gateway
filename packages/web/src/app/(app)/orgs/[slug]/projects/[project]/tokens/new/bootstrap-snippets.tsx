'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui';
import type { MintFormBinding } from './mint-types';

type Tab = 'env' | 'mcp' | 'claude' | 'curl';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function buildEnvLocal(apiKey: string): string {
  return `# Vaubaan Gateway token — paste into your project's .env.local\nVAUBAAN_TOKEN=${apiKey}`;
}

function buildMcpJson(gatewayUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        vaubaan: {
          url: `${gatewayUrl}/api/v1/mcp`,
          headers: { Authorization: 'Bearer ${VAUBAAN_TOKEN}' },
        },
      },
    },
    null,
    2,
  );
}

function buildClaudeMd(
  orgSlug: string,
  projectSlug: string,
  bindings: MintFormBinding[],
  acceptedRisks: string[],
): string {
  const lines: string[] = ['# Vaubaan Gateway', '', `Project: ${orgSlug}/${projectSlug}`, ''];
  if (bindings.length > 0) {
    lines.push('## Bindings');
    for (const b of bindings) {
      const env = b.env ? ` [${b.env}]` : '';
      lines.push(`- ${b.provider}${env}: ${b.display_name}`);
    }
    lines.push('');
  }
  if (acceptedRisks.length > 0) {
    lines.push('## Accepted risks');
    for (const r of acceptedRisks) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }
  lines.push(
    'This token authorises the MCP tools listed above. Do not request',
    'tools outside the accepted risks — the gateway will deny them.',
  );
  return lines.join('\n');
}

function buildCurl(gatewayUrl: string, apiKey: string): string {
  return `curl -s ${gatewayUrl}/api/v1/mcp \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .`;
}

const TAB_LABELS: Record<Tab, string> = {
  env: '.env.local',
  mcp: '.mcp.json',
  claude: 'CLAUDE.md',
  curl: 'curl verify',
};

export function BootstrapSnippets({
  apiKey,
  orgSlug,
  projectSlug,
  bindings,
  acceptedRisks,
}: {
  apiKey: string;
  orgSlug: string;
  projectSlug: string;
  bindings: MintFormBinding[];
  acceptedRisks: string[];
}) {
  const [tab, setTab] = useState<Tab>('env');
  const gatewayUrl =
    typeof window !== 'undefined' ? window.location.origin : 'https://gateway.vaubaan.com';

  const snippets: Record<Tab, string> = {
    env: buildEnvLocal(apiKey),
    mcp: buildMcpJson(gatewayUrl),
    claude: buildClaudeMd(orgSlug, projectSlug, bindings, acceptedRisks),
    curl: buildCurl(gatewayUrl, apiKey),
  };

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>Bootstrap kit</h3>
      <p
        style={{
          margin: '0 0 var(--space-3)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
        }}
      >
        Copy these into your project to wire up Claude Code in 30 seconds.
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '4px 10px',
              fontSize: 'var(--text-xs)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              background: t === tab ? 'var(--surface-base)' : 'transparent',
              color: t === tab ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontWeight: t === tab ? 600 : 400,
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            padding: 'var(--space-3)',
            background: 'var(--surface-base)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            fontSize: 12,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            margin: 0,
          }}
        >
          {snippets[tab]}
        </pre>
        <div style={{ position: 'absolute', top: 4, right: 4 }}>
          <CopyButton text={snippets[tab]} />
        </div>
      </div>
    </div>
  );
}
