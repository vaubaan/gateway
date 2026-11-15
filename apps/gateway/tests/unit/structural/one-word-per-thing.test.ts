/**
 * Structural test (ADR one-word-per-thing-account-service-plugin): what a person or an
 * agent reads says **account**, **service** and **plugin**, each in its one sense, never the
 * words they replaced. The scan covers the interface's words (`lib/vocabulary.ts`), the
 * agent's bootstrap text, the public site (its documentation, its landing and trust
 * pages), the handbooks, and every plugin's README, risk catalog, tool schemas, data model
 * and the declarations the site and the connect page show (credential guide, summary,
 * tool titles).
 *
 * - **connection** (rename R1) keeps its unrelated senses — a TLS, SMTP, IMAP, SSH or
 *   database connection, a Git connection at Vercel, a socket — and the names that cannot
 *   move: the callback registered at the services and the brokers
 *   (`/connections/callback/<plugin>`), the slugs of accepted ADRs, the names of applied
 *   migrations. `reconnect`, `connected` and `Connect an account` are other words.
 * - **provider** (rename R2) is said only of a sign-in provider (identity provider), of
 *   the OAuth provider an OAuth broker holds a client at (and the broker's `providers`
 *   key), of another product's own term (Supabase's SSO providers), and in the names that
 *   cannot move: retired configuration keys, ADR slugs, migrations, the broker's provider
 *   table and its package.
 * - **plugin** is the code package: the site's prose does not credit "the <Name> plugin"
 *   with what the service lets an agent do.
 *
 * Each allowance is an explicit pattern below, matched on its line, with its reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

interface Allowance {
  readonly pattern: RegExp;
  readonly why: string;
}

/** The human-facing files, as git tracks them. */
const SCOPE: readonly RegExp[] = [
  /^apps\/gateway\/src\/lib\/vocabulary\.ts$/,
  /^apps\/gateway\/src\/app\/agent-bootstrap\.md\/content\.md$/,
  /^apps\/website\/content\/.+\.mdx?$/,
  /^apps\/website\/src\/site\/landing\.ts$/,
  /^apps\/website\/src\/content\/trust\.ts$/,
  /^docs\/handbook\/.+\.md$/,
  /^plugins\/[^/]+\/README\.md$/,
  /^plugins\/[^/]+\/src\/(risk-catalog\.yaml|tool-schemas\.json|data-model\.ts)$/,
  /^plugins\/[^/]+\/src\/(credential|index|tool-titles)\.ts$/,
];

/** The site's prose, where "the <Name> plugin" must not stand for the service. */
const SITE_PROSE: readonly RegExp[] = [
  /^apps\/website\/content\/.+\.mdx?$/,
  /^apps\/website\/src\/site\/landing\.ts$/,
  /^plugins\/[^/]+\/README\.md$/,
];

/**
 * R1: the word, alone or at the head of a name (`connection_id`, `connectionId`,
 * `CONNECTIONS_PATH`): `reconnection` and `Connect` are not it.
 */
const CONNECTION = /(?<![A-Za-z])(?:[Cc]onnections?(?![a-z])|CONNECTIONS?(?![A-Z]))/;

/** R2: the word, alone or at the head or the tail of a name (`providerId`, `ProviderPlugin`). */
const PROVIDER = /(?<![a-z])(?:[Pp]roviders?(?![a-z])|PROVIDERS?(?![A-Z]))/;

/** R2, plugin: "the GitHub plugin lets an agent…" says plugin for the service. */
const PLUGIN_FOR_SERVICE =
  /\b[Tt]he (?:[A-Z][A-Za-z0-9.]*)(?: [A-Z][A-Za-z0-9.]*)* plugin (?:lets|allows|can|gives|reaches|reads|writes)\b/;

/** Senses and names R1 does not touch, each with its reason. */
const CONNECTION_ALLOWED: readonly Allowance[] = [
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
    why: 'a network or service-side connection',
  },
  {
    pattern: /opens no connection|verified on every connection|destroys the connection/,
    why: 'the SSH or IMAP session of one call',
  },
  {
    pattern: /one SMTP connection per send|one connection\s*$|every connection (needs|is verified)/,
    why: 'the SMTP or SSH session of a call',
  },
  {
    pattern: /vaubaan\/connection-key\/v1:/,
    why: 'the KDF context of every stored credential: bytes that never change',
  },
  {
    pattern: /limits\.connections|VAUBAAN_LIMITS_CONNECTIONS/,
    why: 'a renamed configuration key, named so that an operator recognises the one they set',
  },
  {
    pattern: /connection → account/,
    why: 'a line that tells the rename R1 itself',
  },
  {
    pattern: /internal connection|[Ii]ntegration connection/,
    why: "Notion's own name for what its token belongs to, quoted as Notion's interface says it",
  },
];

/** Senses and names R2 does not touch, each with its reason. */
const PROVIDER_ALLOWED: readonly Allowance[] = [
  {
    pattern:
      /[Ss]ign[-_ ]?[Ii]n[-_ ]?[Pp]roviders?|[Ii]dentity providers?|single-provider|OpenID (Connect )?providers?/,
    why: 'the sign-in provider (identity provider) people sign in through, said in full',
  },
  {
    pattern:
      /\bbroker\b.*\bproviders?\b|\bproviders?\b.*\bbroker\b|OAuth providers?|BROKER_PROVIDER|broker: \{ provider/i,
    why: 'the OAuth provider an OAuth broker holds a client at, the broker protocol’s word (`provider` in `POST /flows`) and its `providers` key',
  },
  {
    pattern: /oauth-providers|provider-table|oauth_brokers\.[^ ]*providers|_PROVIDERS\b/,
    why: 'the broker’s provider table, its package and its configuration key',
  },
  {
    pattern: /providers\.<id>|`providers`|VAUBAAN_PROVIDER_/,
    why: 'a retired configuration key, named as the operator wrote it',
  },
  {
    pattern:
      /decisions\/[a-z0-9-]*provider[a-z0-9-]*\.md|provider-error-text-stays-with-the-agent|provider-side-revocation-on-connection-revoke|\d{4}_[a-z_]*provider[a-z_]*/,
    why: 'an accepted ADR keeps its slug, an applied migration its name',
  },
  {
    pattern:
      /provider →|says provider|renamed provider|before 0\.9\.4|before 0037|`provider-reports`|`provider:`|\/docs\/providers/,
    why: 'a line that tells the rename R2 itself, or names a former address the site redirects',
  },
  {
    pattern: /`provider_id`|emails, providers, last sign-in/,
    why: 'Supabase’s own names: the argument of its SSO endpoints, the auth providers of a user',
  },
  {
    pattern:
      /SSO providers?|sso[-_]providers?|SsoProviders?|[Tt]hird-party (JWT )?(auth |sign-in )?providers?|SMS provider|auth providers?|external providers|captcha_provider|sms_provider|Workload Identity Federation provider|PROVIDER_ID_PATTERN/,
    why: 'another product’s own term (Supabase, Google Cloud), quoted as it says it',
  },
];

/**
 * The OAuth broker's own documentation: provider is its protocol's word throughout (the
 * `provider` field of `POST /flows`, `/token` and `/revoke`, its provider table, its
 * `provider_*` error codes), the RFC 6749 sense, never a service.
 */
const PROVIDER_ALLOWED_FILES: ReadonlySet<string> = new Set([
  'docs/handbook/oauth-broker.md',
  'docs/handbook/oauth-broker-contract.md',
  'apps/website/content/docs/operations/oauth-broker.mdx',
]);

function trackedFiles(scope: readonly RegExp[]): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((file) => scope.some((s) => s.test(file)));
}

/** The lines of a text that say `word` outside every allowance. */
function linesSaying(text: string, word: RegExp, allowed: readonly Allowance[]): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => word.test(line) && !allowed.some((a) => a.pattern.test(line)))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

const connectionLines = (text: string) => linesSaying(text, CONNECTION, CONNECTION_ALLOWED);
const providerLines = (text: string) => linesSaying(text, PROVIDER, PROVIDER_ALLOWED);
const pluginLines = (text: string) => linesSaying(text, PLUGIN_FOR_SERVICE, []);

function offenders(files: readonly string[], lines: (text: string) => string[]): string[] {
  return files.flatMap((file) =>
    lines(readFileSync(resolve(REPO, file), 'utf8')).map((line) => `${file}:${line}`),
  );
}

describe('structural: one word per thing — account, service, plugin', () => {
  const files = trackedFiles(SCOPE);

  it('scans the human-facing text', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/gateway/src/lib/vocabulary.ts',
        'apps/website/content/docs/concepts.mdx',
        'apps/website/content/docs/services/index.mdx',
        'apps/website/src/site/landing.ts',
        'docs/handbook/accounts.md',
        'docs/handbook/services/github.md',
        'plugins/github/README.md',
        'plugins/github/src/risk-catalog.yaml',
        'plugins/github/src/credential.ts',
        'plugins/vaubaan/src/tool-schemas.json',
      ]),
    );
  });

  it('finds the retired word where it means an account, and allows its other senses', () => {
    expect(connectionLines('A GitHub connection reaches repositories.')).toHaveLength(1);
    expect(connectionLines('`connection_id`, `list_my_connections`')).toHaveLength(1);
    expect(connectionLines('ConnectionContext')).toHaveLength(1);
    expect(connectionLines('over a pinned TLS connection')).toEqual([]);
    expect(connectionLines('`<public_url>/connections/callback/<plugin>`')).toEqual([]);
    expect(connectionLines('needs reconnection; Connect an account')).toEqual([]);
  });

  it('finds provider where it means a service, and allows the sign-in provider and the broker’s', () => {
    expect(providerLines('Connect a provider.')).toHaveLength(1);
    expect(providerLines('`provider_label`, `ProviderPlugin`, `PROVIDER_ID`')).toHaveLength(1);
    expect(providerLines('the provider’s answer')).toHaveLength(1);
    expect(providerLines('People sign in through a sign-in provider.')).toEqual([]);
    expect(providerLines('Behind your identity provider (OpenID Connect).')).toEqual([]);
    expect(providerLines('a broker serving the provider `google`')).toEqual([]);
    expect(providerLines('Register an SSO provider')).toEqual([]);
    expect(providerLines('`providers.<id>.*` and `VAUBAAN_PROVIDER_<ID>_<FIELD>`')).toEqual([]);
  });

  it('finds "the <Name> plugin" credited with what the service does', () => {
    expect(pluginLines('The GitHub plugin lets an agent push.')).toHaveLength(1);
    expect(pluginLines('The Google Calendar plugin can read events.')).toHaveLength(1);
    expect(pluginLines('GitHub lets an agent push; pin the GitHub plugin to 5.1.0.')).toEqual([]);
  });

  it('no human-facing text says connection for an account', () => {
    expect(offenders(files, connectionLines)).toEqual([]);
  });

  it('no human-facing text says provider for a service', () => {
    const scanned = files.filter((file) => !PROVIDER_ALLOWED_FILES.has(file));
    expect(scanned.length).toBe(files.length - PROVIDER_ALLOWED_FILES.size);
    expect(offenders(scanned, providerLines)).toEqual([]);
  });

  it('the site says what a service lets an agent do, not what its plugin does', () => {
    expect(offenders(trackedFiles(SITE_PROSE), pluginLines)).toEqual([]);
  });
});
