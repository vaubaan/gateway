'use client';

/**
 * The key and the setup kit (spec §4.4).
 *
 * - `KitSteps` — what an agent needs to start: one line for Claude Code or for
 *   Codex (ADR mission-key-reaches-an-agent-through-its-own-secret-store), or the
 *   variable and the configuration for any other client; then the instructions and a
 *   check. With the key in the first snippet right after it was made; with
 *   its masked form on a page opened later.
 * - `KeyReveal` — the key, whole, in the one filled box of the view, then the
 *   kit. The only place a key is ever displayed.
 * - `RevealDialog` — `KeyReveal` in a dialog that Escape does not close: the
 *   key it shows cannot be shown again, and one stray key press would lose it.
 *
 * The commands, the variable and the MCP configuration keep the names the
 * protocol gives them; the words around them are the interface's.
 */
import { Button, ButtonLink, CodeBlock, Dialog, SecretBox, StepMark } from '@/components/ui';
import { MISSION_ACTIONS, MISSION_WORDS } from '@/lib/vocabulary';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';

import styles from './missions.styles';
import { isRecord } from '@vaubaan/shared/guards';

function KitStep({
  n,
  title,
  hint,
  text,
  label,
  wrap = false,
  testId,
}: {
  /** The step's number; absent on an alternative to the step above ("Or…"). */
  n?: number;
  title: string;
  hint: string;
  text: string;
  label: string;
  wrap?: boolean;
  testId: string;
}) {
  return (
    <div className={styles.kitStep}>
      <div className={styles.kitHead}>
        {n !== undefined && <StepMark n={n} />}
        <h3 className={styles.kitTitle}>{title}</h3>
        <span className={styles.kitHint}>{hint}</span>
      </div>
      <CodeBlock label={label} wrap={wrap} testId={testId}>
        {text}
      </CodeBlock>
    </div>
  );
}

export function KitSteps({ kit }: { kit: BootstrapKit }) {
  // The key is shown once: on a page opened later the lines carry its masked form.
  const whereKey = (file: string): string =>
    kit.reveals_secret
      ? `one line; the key goes in ${file}, outside your project. Revoke it from the mission`
      : 'the key was shown once: replace it to get a line that works';
  return (
    <div className={styles.kit} data-testid="kit">
      <KitStep
        n={1}
        title="Add it to Claude Code"
        hint={whereKey('~/.claude.json')}
        text={kit.claude_code}
        label="Command for Claude Code"
        wrap
        testId="kit-claude-code"
      />
      <KitStep
        title="Or add it to Codex"
        hint={whereKey('~/.codex/config.toml')}
        text={kit.codex}
        label="Command for Codex"
        wrap
        testId="kit-codex"
      />
      {kit.claude_desktop !== null && (
        <div className={styles.kitStep}>
          <div className={styles.kitHead}>
            <h3 className={styles.kitTitle}>Or add it to Claude Desktop</h3>
            <span className={styles.kitHint}>
              no terminal; Claude Desktop keeps the key in your system’s secret store
            </span>
          </div>
          <p className={styles.kitHint} data-testid="kit-claude-desktop">
            <ButtonLink href={kit.claude_desktop} size="sm">
              Download the file for Claude Desktop
            </ButtonLink>{' '}
            Open it, choose Install, and paste the key above when it asks. The file holds no key.
          </p>
        </div>
      )}
      <KitStep
        title="Or, for another agent, put the key in its environment"
        hint={
          kit.reveals_secret
            ? 'never in a file you commit'
            : 'the key was shown once: replace it to get a new one'
        }
        text={kit.env}
        label="Environment variable"
        testId="kit-env"
      />
      <KitStep
        title="…and point it at the gateway"
        hint="any MCP client, and a file your team commits: it names the variable, never the key"
        text={kit.mcp_json}
        label="MCP configuration"
        testId="kit-mcp"
      />
      <KitStep
        n={2}
        title="Tell the agent what it has"
        hint="the gateway hands it a short form when it connects; paste this for the whole text"
        text={kit.agent_instructions}
        label="Instructions for the agent"
        wrap
        testId="kit-instructions"
      />
      {kit.git !== null ? (
        <KitStep
          n={3}
          title="Use the gateway as the git remote"
          hint="clone and push with plain git; the key stays in the variable"
          text={kit.git}
          label="Git configuration"
          testId="kit-git"
        />
      ) : null}
      <KitStep
        n={kit.git !== null ? 4 : 3}
        title="Check it works"
        hint="lists the tools this key can call"
        text={kit.verify}
        label="Verification command"
        testId="kit-verify"
      />
    </div>
  );
}

export function KeyReveal({
  secret,
  kit,
  label = 'Your key',
}: {
  secret: string;
  kit: BootstrapKit;
  /** Whose key it is: "Your key", "The machine key CI runner". */
  label?: string;
}) {
  return (
    <div className={styles.reveal}>
      <SecretBox value={secret} label={label} testId="revealed-key" />
      <KitSteps kit={kit} />
    </div>
  );
}

/** A key that was just made, with what it came with. */
export interface RevealedKey {
  readonly title: string;
  readonly secret: string;
  readonly kit: BootstrapKit;
  readonly label?: string;
}

export function RevealDialog({ revealed, onDone }: { revealed: RevealedKey; onDone: () => void }) {
  return (
    <Dialog
      open
      width="lg"
      divided
      // The key cannot be shown again: only the button closes the dialog.
      dismissible={false}
      onClose={onDone}
      title={revealed.title}
      description={MISSION_WORDS.keyShownOnce}
      testId="reveal-dialog"
      footer={
        <Button type="button" variant="primary" onClick={onDone}>
          {MISSION_ACTIONS.savedKey}
        </Button>
      }
    >
      <KeyReveal secret={revealed.secret} kit={revealed.kit} label={revealed.label} />
    </Dialog>
  );
}

/** The key and the kit of an answer that carries a secret, once; `null` for any other body. */
export function revealedOf(
  body: unknown,
): { readonly secret: string; readonly kit: BootstrapKit } | null {
  if (!isRecord(body) || !isRecord(body.token) || !isRecord(body.kit)) return null;
  const { secret } = body.token;
  if (typeof secret !== 'string') return null;
  return { secret, kit: body.kit as unknown as BootstrapKit };
}
