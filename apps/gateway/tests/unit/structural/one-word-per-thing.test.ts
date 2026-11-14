/**
 * Structural test (ADR one-word-per-thing-account-service-plugin): what a person
 * or an agent reads says account, never the word it replaced. The scan covers the
 * interface's words (`lib/vocabulary.ts`), the agent's bootstrap text, the public
 * site's documentation, the handbooks, and every plugin's README, risk catalog,
 * tool schemas and data model.
 *
 * The word keeps its unrelated senses — a TLS, SMTP, IMAP, SSH or database
 * connection, a Git connection at Vercel, a socket — and the names that cannot
 * move: the callback registered at the services and the brokers
 * (`/connections/callback/<plugin>`), the slugs of accepted ADRs, the names of
 * applied migrations. Each is an explicit pattern below, matched on its line;
 * `reconnect`, `connected` and `Connect an account` are other words.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * The retired word, alone or at the head of a name (`connection_id`, `connectionId`,
 * `CONNECTIONS_PATH`): `reconnection` and `Connect` are not it.
 */
const RETIRED = /(?<![A-Za-z])(?:[Cc]onnections?(?![a-z])|CONNECTIONS?(?![A-Z]))/;

/** The human-facing files, as git tracks them. */
const SCOPE: readonly RegExp[] = [
  /^apps\/gateway\/src\/lib\/vocabulary\.ts$/,
  /^apps\/gateway\/src\/app\/agent-bootstrap\.md\/content\.md$/,
  /^apps\/website\/content\/.+\.mdx?$/,
  /^docs\/handbook\/.+\.md$/,
  /^plugins\/[^/]+\/README\.md$/,
  /^plugins\/[^/]+\/src\/(risk-catalog\.yaml|tool-schemas\.json|data-model\.ts)$/,
];

/** Senses and names the rename does not touch, each with its reason. */
const ALLOWED: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\/connections\/callback\b|\(app\)\/connections\/callback/,
    why: 'the callback registered at the services and the brokers keeps its path',
  },
  {
    pattern: /decisions\/[a-z-]*connection[a-z-]*\.md|\[[a-z-]*connection[a-z-]*\]/,
    why: 'an accepted ADR keeps its slug',
  },
  {
    pattern: /\b(TLS|SMTP|IMAP|TCP|SSH|database|Git) connections?\b/,
    why: 'a network or provider-side connection',
  },
  {
    pattern: /opens no connection|verified on every connection|destroys the connection/,
    why: 'the SSH or IMAP session of one call',
  },
  { pattern: /one SMTP connection per send|one connection\s*$/, why: 'the SMTP session of a send' },
  {
    pattern: /vaubaan\/connection-key\/v1:/,
    why: 'the KDF context of every stored credential: bytes that never change',
  },
  {
    pattern: /limits\.connections|VAUBAAN_LIMITS_CONNECTIONS/,
    why: 'a renamed configuration key, named so that an operator recognises the one they set',
  },
];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((file) => SCOPE.some((scope) => scope.test(file)));
}

/** The lines of a file that say the retired word in a sense the rename covers. */
function offendingLines(text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => RETIRED.test(line) && !ALLOWED.some((a) => a.pattern.test(line)))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe('structural: one word per thing — account, never the word it replaced', () => {
  const files = trackedFiles();

  it('scans the human-facing text', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/gateway/src/lib/vocabulary.ts',
        'apps/website/content/docs/concepts.mdx',
        'docs/handbook/accounts.md',
        'plugins/github/README.md',
        'plugins/github/src/risk-catalog.yaml',
        'plugins/vaubaan/src/tool-schemas.json',
      ]),
    );
  });

  it('finds the retired word where it means an account, and allows its other senses', () => {
    expect(offendingLines('A GitHub connection reaches repositories.')).toHaveLength(1);
    expect(offendingLines('`connection_id`, `list_my_connections`')).toHaveLength(1);
    expect(offendingLines('ConnectionContext')).toHaveLength(1);
    expect(offendingLines('over a pinned TLS connection')).toEqual([]);
    expect(offendingLines('`<public_url>/connections/callback/<plugin>`')).toEqual([]);
    expect(offendingLines('needs reconnection; Connect an account')).toEqual([]);
  });

  it('no human-facing text says connection for an account', () => {
    const offenders = files.flatMap((file) =>
      offendingLines(readFileSync(resolve(REPO, file), 'utf8')).map((line) => `${file}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
