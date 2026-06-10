'use client';

import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Row,
  Select,
} from '@/components/ui';
import type { ParsedTool } from '@/lib/bash/parse';

interface Host {
  host_slug: string;
  host_address: string;
  ssh_user: string;
}

interface TestResult {
  ok?: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  truncated?: boolean;
  error?: string;
}

/**
 * Per-tool runner ; the target host (env) is picked once at the top, then
 * every Run button targets that selection.
 *
 * Renders nothing when no host is attached — the parent gates the render
 * on `hosts.length > 0` today, but typing the early-return locally avoids
 * relying on that invariant (and removes the `hosts[0]!` non-null assertion
 * that flagged a future-bug risk if the gate ever drifts).
 */
export function RunnerCard({
  orgSlug,
  bindingId,
  tools,
  hosts,
}: {
  orgSlug: string;
  bindingId: string;
  tools: ParsedTool[];
  hosts: Host[];
}) {
  const firstHost = hosts[0];
  const [host, setHost] = useState<string>(firstHost?.host_slug ?? '');
  if (!firstHost) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run tools</CardTitle>
        <Badge tone="neutral">{tools.length} tool(s)</Badge>
      </CardHeader>
      <CardBody>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Field label="Target host (env)">
            <Select value={host} onChange={(e) => setHost(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.host_slug} value={h.host_slug}>
                  {h.host_slug} — {h.ssh_user}@{h.host_address}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {tools.map((t) => (
            <li
              key={t.functionName}
              style={{
                padding: 'var(--space-3) 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <ToolRow orgSlug={orgSlug} bindingId={bindingId} host={host} tool={t} />
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function ToolRow({
  orgSlug,
  bindingId,
  host,
  tool,
}: {
  orgSlug: string;
  bindingId: string;
  host: string;
  tool: ParsedTool;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(`/api/v1/bash-bindings/${bindingId}/run-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          host_slug: host,
          tool: tool.functionName,
          args,
          timeout_s: 60,
        }),
      });
      const json = (await res.json()) as TestResult;
      setResult(json);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : 'unknown error' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <Row gap="var(--space-2)">
        <Code>{tool.functionName}</Code>
        <Badge tone={tool.action === 'write' ? 'warning' : 'success'}>{tool.action}</Badge>
        <Code>ring {tool.ring}</Code>
      </Row>
      {tool.doc && (
        <p
          style={{
            margin: '4px 0 var(--space-2)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {tool.doc}
        </p>
      )}

      {tool.args.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-2)',
          }}
        >
          {tool.args.map((a) => (
            <Field
              key={a.name}
              label={
                <>
                  {a.name}{' '}
                  <span style={{ color: 'var(--text-subtle)', fontWeight: 'normal' }}>
                    ({a.type}
                    {a.required ? ', required' : ''}
                    {a.defaultValue !== undefined ? `, default=${a.defaultValue}` : ''})
                  </span>
                </>
              }
            >
              <Input
                type={a.type === 'integer' ? 'number' : 'text'}
                value={args[a.name] ?? ''}
                placeholder={a.defaultValue ?? ''}
                onChange={(e) => setArgs((prev) => ({ ...prev, [a.name]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      )}

      <Button size="sm" variant="secondary" onClick={() => void run()} disabled={running}>
        {running ? 'Running…' : `▶ Run on ${host}`}
      </Button>

      {result && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          {result.error ? (
            <Banner tone="danger">{result.error}</Banner>
          ) : (
            <>
              <Row gap="var(--space-2)">
                <Badge tone={result.ok ? 'success' : 'danger'}>exit {result.exit_code}</Badge>
                <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                  {result.duration_ms} ms{result.truncated ? ' · truncated' : ''}
                </span>
              </Row>
              {result.stdout && (
                <pre
                  style={{
                    marginTop: 4,
                    padding: 'var(--space-2)',
                    background: 'var(--surface-2)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-mono)',
                    maxHeight: 300,
                    overflow: 'auto',
                  }}
                >
                  {result.stdout}
                </pre>
              )}
              {result.stderr && (
                <pre
                  style={{
                    marginTop: 4,
                    padding: 'var(--space-2)',
                    background: 'var(--surface-2)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--accent-danger-fg)',
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-mono)',
                    maxHeight: 200,
                    overflow: 'auto',
                  }}
                >
                  {result.stderr}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
