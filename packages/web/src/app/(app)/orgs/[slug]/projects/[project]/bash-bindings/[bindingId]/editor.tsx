'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
  Textarea,
} from '@/components/ui';
import type { ParsedScript, ParsedTool } from '@/lib/bash/parse';

/**
 * Two cards :
 *   1. Script editor (textarea, save → PATCH the binding, re-parse).
 *   2. Tool runner (one card per tool with args + Run button) — only when
 *      parsed_meta exists.
 */
export function BashBindingEditor({
  orgSlug,
  bindingId,
  hostSlug,
  initialBash,
  parsedMeta,
}: {
  orgSlug: string;
  bindingId: string;
  hostSlug: string;
  initialBash: string;
  parsedMeta: ParsedScript | null;
}) {
  return (
    <>
      <ScriptEditor orgSlug={orgSlug} bindingId={bindingId} initial={initialBash} />
      {parsedMeta && (
        <ToolRunner
          orgSlug={orgSlug}
          bindingId={bindingId}
          hostSlug={hostSlug}
          tools={parsedMeta.tools}
        />
      )}
    </>
  );
}

function ScriptEditor({
  orgSlug,
  bindingId,
  initial,
}: {
  orgSlug: string;
  bindingId: string;
  initial: string;
}) {
  const router = useRouter();
  const [bash, setBash] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fetch(`/api/v1/bash-bindings/${bindingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, bash_content: bash || null }),
      });
      const json = (await res.json()) as { binding?: unknown; error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setOkMsg('Saved.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Script</CardTitle>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </CardHeader>
      <CardBody>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
          Annotated bash. Each function with <Code>{`# @vaubaan: ring=X action=Y`}</Code> above it
          becomes an MCP tool ; functions without an annotation are private helpers.
        </p>
        {error && <Banner tone="danger">{error}</Banner>}
        {okMsg && <Banner tone="success">{okMsg}</Banner>}
        <Textarea
          rows={24}
          value={bash}
          onChange={(e) => setBash(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
          placeholder={
            '#!/usr/bin/env bash\n# @vaubaan-rings: process\n\n# @vaubaan: ring=process action=read\n# @vaubaan-doc: ...\nmy_status() {\n  systemctl status my.service\n}\n'
          }
        />
      </CardBody>
    </Card>
  );
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

function ToolRunner({
  orgSlug,
  bindingId,
  hostSlug,
  tools,
}: {
  orgSlug: string;
  bindingId: string;
  hostSlug: string;
  tools: ParsedTool[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run tools on {hostSlug}</CardTitle>
        <Badge tone="neutral">{tools.length} tool(s)</Badge>
      </CardHeader>
      <CardBody>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {tools.map((t) => (
            <li
              key={t.functionName}
              style={{
                padding: 'var(--space-3) 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <ToolRow orgSlug={orgSlug} bindingId={bindingId} hostSlug={hostSlug} tool={t} />
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
  hostSlug,
  tool,
}: {
  orgSlug: string;
  bindingId: string;
  hostSlug: string;
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
        {running ? 'Running…' : `▶ Run on ${hostSlug}`}
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
