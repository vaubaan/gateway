'use client';

/**
 * The bootstrap kit (spec §4.4): three numbered snippets to copy and a
 * verification command. Rendered with the secret right after issuance or
 * rotation (reveal-once dialog) and with the masked prefix on the mission
 * page.
 */
import { useState } from 'react';

import { Button } from '@/components/ui';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';

import styles from './missions.module.css';

function Snippet({
  number,
  title,
  text,
  testId,
}: {
  number: string;
  title: string;
  text: string;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context, denied permission): the text stays selectable.
      setCopied(false);
    }
  }
  return (
    <div className={styles.kitStep}>
      <div className={styles.kitHead}>
        <span>
          <span className={styles.kitNumber}>{number}</span>
          {title}
        </span>
        <Button type="button" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={styles.snippet} data-testid={testId}>
        {text}
      </pre>
    </div>
  );
}

export function BootstrapKitView({ kit }: { kit: BootstrapKit }) {
  return (
    <div className={styles.kit}>
      <Snippet
        number="1"
        title={
          kit.reveals_secret
            ? 'Set the mission token in the environment of the agent'
            : 'Environment variable (the secret was shown once; rotate to get a new one)'
        }
        text={kit.env}
        testId="kit-env"
      />
      <Snippet
        number="2"
        title="MCP configuration (.mcp.json) — refers to the variable, never holds the secret"
        text={kit.mcp_json}
        testId="kit-mcp"
      />
      <Snippet
        number="3"
        title="Instructions for the agent (CLAUDE.md, AGENTS.md or the system prompt)"
        text={kit.agent_instructions}
        testId="kit-instructions"
      />
      <Snippet number="✓" title="Check that it works" text={kit.verify} testId="kit-verify" />
    </div>
  );
}

/** The reveal-once dialog: the only place the secret is ever displayed. */
export function RevealDialog({
  title,
  kit,
  onDone,
}: {
  title: string;
  kit: BootstrapKit;
  onDone: () => void;
}) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="reveal-title">
      <div className={styles.dialog}>
        <div>
          <h2 id="reveal-title">{title}</h2>
          <p className={styles.muted}>
            The token is shown once. Copy snippet 1 now; afterwards this page only shows its prefix,
            and “Rotate” issues a new token.
          </p>
        </div>
        <BootstrapKitView kit={kit} />
        <div className={styles.dialogFoot}>
          <Button type="button" variant="primary" onClick={onDone}>
            I copied the token
          </Button>
        </div>
      </div>
    </div>
  );
}
