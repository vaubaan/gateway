'use client';

/**
 * Render a mermaid diagram source string. SSR-safe : renders the raw source
 * inside a `<pre>` on the server, then upgrades to an SVG once the client
 * hydrates and the `mermaid` lib has loaded (dynamic import — keeps the
 * server bundle slim).
 *
 * Theme : the rest of the app runs in `data-theme="light"` (white surface,
 * dark text). The previous `theme: 'dark'` produced a black box inside a
 * white card — visually broken. We switch to `'neutral'` and override the
 * three colors that matter (background, text, line) with the gray-* tokens
 * already used by `tokens.css`.
 *
 * Why dynamic + client-only :
 *  - `mermaid` registers DOM globals during init ; importing it server-side
 *    crashes Next's RSC build with `document is not defined`.
 *  - Each `<MermaidDiagram>` instance gets a unique id, so multiple diagrams
 *    on the same page do not collide on mermaid's internal cache.
 */

import { useEffect, useId, useState } from 'react';

export interface MermaidDiagramProps {
  readonly source: string;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '_');
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'strict',
          fontFamily: 'inherit',
          themeVariables: {
            // Background of nodes & containers — match the app's raised
            // surface so the diagram sits inside the card without a contrast
            // hop.
            primaryColor: '#f9fafb',
            primaryTextColor: '#111827',
            primaryBorderColor: '#d1d5db',
            lineColor: '#6b7280',
            secondaryColor: '#e5e7eb',
            tertiaryColor: '#ffffff',
            // ER-diagram specific — keep relationships readable on a
            // light card.
            background: '#ffffff',
            mainBkg: '#f9fafb',
            textColor: '#111827',
          },
        });
        const result = await mermaid.render(`mmd-${id}`, source);
        if (!cancelled) setSvg(result.svg);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (error) {
    return (
      <div
        style={{
          padding: 'var(--space-3)',
          border: '1px solid var(--accent-danger-fg)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--accent-danger-fg)',
          fontSize: 'var(--text-sm)',
        }}
      >
        <strong>Mermaid render failed:</strong> {error}
        <pre
          style={{
            marginTop: 'var(--space-2)',
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            fontSize: 'var(--text-xs)',
          }}
        >
          {source}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <pre
        style={{
          padding: 'var(--space-3)',
          background: 'var(--bg-subtle, transparent)',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
        }}
      >
        {source}
      </pre>
    );
  }

  return (
    <div
      style={{
        overflowX: 'auto',
        padding: 'var(--space-3)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: '#ffffff',
      }}
      // mermaid output is sanitized server-side by mermaid itself (securityLevel:'strict')
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
