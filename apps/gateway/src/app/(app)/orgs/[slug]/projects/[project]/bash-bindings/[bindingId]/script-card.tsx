'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Textarea,
} from '@/components/ui';

/**
 * Script card with the standardised Edit / Save / Cancel pattern.
 * View mode : pre-formatted script + Edit button in header.
 * Edit mode : textarea + Save / Cancel in header.
 */
export function ScriptCard({
  orgSlug,
  bindingId,
  initial,
}: {
  orgSlug: string;
  bindingId: string;
  initial: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [bash, setBash] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (bash === initial) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/bash-bindings/${bindingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, bash_content: bash || null }),
      });
      const json = (await res.json()) as { binding?: unknown; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Script</CardTitle>
        {editing ? (
          <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setBash(initial);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {editing ? (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
              Annotated bash. Each function with <Code>{`# @vaubaan: ring=X action=Y`}</Code> above
              it becomes an MCP tool ; functions without an annotation are private helpers. Changing
              the script re-parses it on save.
            </p>
            <Textarea
              rows={24}
              value={bash}
              onChange={(e) => setBash(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
            />
          </>
        ) : initial ? (
          <pre
            style={{
              margin: 0,
              padding: 'var(--space-3)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-mono)',
              overflow: 'auto',
              maxHeight: 480,
            }}
          >
            {initial}
          </pre>
        ) : (
          <p style={{ color: 'var(--text-subtle)', margin: 0 }}>
            No script attached yet. Click <strong>Edit</strong> to paste one.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
