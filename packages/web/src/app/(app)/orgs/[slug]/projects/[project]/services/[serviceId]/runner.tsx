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
import type { ParsedTool } from '@/lib/services/parse';

interface Binding {
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
 * Per-tool runner UI : for each declared function, render an inline form
 * with its args + a Run button. Results land in a small log below each form.
 */
export function ServiceRunner({
  orgSlug,
  serviceId,
  tools,
  bindings,
}: {
  orgSlug: string;
  serviceId: string;
  tools: ParsedTool[];
  bindings: Binding[];
}) {
  if (bindings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Test runner</CardTitle>
        </CardHeader>
        <CardBody>
          <Banner tone="warning">
            No SSH binding for this project — add one to invoke the service&apos;s tools.
          </Banner>
        </CardBody>
      </Card>
    );
  }

  const [host, setHost] = useState(bindings[0]!.host_slug);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test runner</CardTitle>
        <Badge tone="neutral">{bindings.length} host(s)</Badge>
      </CardHeader>
      <CardBody>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Field label="Target host">
            <Select value={host} onChange={(e) => setHost(e.target.value)}>
              {bindings.map((b) => (
                <option key={b.host_slug} value={b.host_slug}>
                  {b.host_slug} — {b.ssh_user}@{b.host_address}
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
              <ToolRow orgSlug={orgSlug} serviceId={serviceId} host={host} tool={t} />
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function ToolRow({
  orgSlug,
  serviceId,
  host,
  tool,
}: {
  orgSlug: string;
  serviceId: string;
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
      const res = await fetch(`/api/v1/services/${serviceId}/test`, {
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

      <Button size="sm" variant="secondary" onClick={run} disabled={running}>
        {running ? 'Running…' : '▶ Run on ' + host}
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
