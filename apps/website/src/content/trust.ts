/**
 * The trust center (website spec §2.5): what the project does for security,
 * each claim linked to the document or the code that backs it, what is not
 * covered, and what leaves an instance. Only what the code does today; what is
 * planned says so. The accepted risks and the out-of-scope items are read from
 * the threat model, so the list cannot drift from it.
 */
import { githubBlob, githubTree } from '../site/constants';
import { cellsOf, sectionsOf, splitFrontmatter } from './markdown';
import { thresholdsSentence, type ValidationThresholds } from './thresholds';

export const THREAT_MODEL = 'docs/handbook/threat-model.md';

export interface AcceptedRisk {
  readonly id: string;
  /** The risk's bold statement, as the threat model words it. */
  readonly statement: string;
}

/** The rows of the threat model's "Accepted risks" table: id and statement. */
export function parseAcceptedRisks(threatModel: string): AcceptedRisk[] {
  const section = sectionsOf(splitFrontmatter(threatModel).body).find(
    (s) => s.heading === 'Accepted risks',
  );
  if (!section) throw new Error(`${THREAT_MODEL}: no "Accepted risks" section`);
  return section.text
    .split('\n')
    .filter((line) => /^\| A\d+/.test(line))
    .map((line) => {
      const [id = '', risk = ''] = cellsOf(line);
      const bold = /\*\*(.+?)\*\*/.exec(risk);
      return { id, statement: (bold?.[1] ?? risk).trim() };
    });
}

/** The bullet list of the threat model's "Out of scope" section, links pointed at GitHub. */
export function parseOutOfScope(threatModel: string): string[] {
  const section = sectionsOf(splitFrontmatter(threatModel).body).find(
    (s) => s.heading === 'Out of scope',
  );
  if (!section) throw new Error(`${THREAT_MODEL}: no "Out of scope" section`);
  const items: string[] = [];
  for (const line of section.text.split('\n').slice(1)) {
    if (line.startsWith('- ')) items.push(line.slice(2).trim());
    else if (line.startsWith('  ') && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    }
  }
  // The first item is about the deployment; the legacy note is for contributors.
  return items.filter((item) => !/legacy/i.test(item));
}

const gh = githubBlob;

export interface TrustInputs {
  readonly acceptedRisks: readonly AcceptedRisk[];
  readonly outOfScope: readonly string[];
  readonly thresholds: ValidationThresholds;
}

export function trustMarkdown({ acceptedRisks, outOfScope, thresholds }: TrustInputs): string {
  return `# Trust center

Vaubaan Gateway is pre-release software that holds your cloud credentials so that coding agents never do; this page says what protects them, what does not, and what leaves an instance, each claim linked to the document or the code that backs it.

**Status, plainly.** Pre-release: 2.0.0-alpha versions are tagged and published as images, a handful of early instances run it, and breaking changes are expected until v2.0.0 ([README](${gh('README.md')}#status), [known limitations](/docs/known-limitations)). There has been no third-party security audit and there is no certification. The threat model and the controls below are the project's own work, reviewed in its repository.

## The trust proposition

- **The agent never holds a service credential.** It holds a mission key. The gateway decrypts the stored credential in memory for the duration of one call, calls the service, and returns only the result ([threat model](${gh(THREAT_MODEL)}#the-trust-proposition), [SECURITY.md](${gh('SECURITY.md')}#trust-model)).
- **No exception.** No tool hands the agent a service token, short-lived or not: the plugin SDK refuses a plugin that declares one, and git goes through the gateway's own remote.
- **Two credentials that never cross.** A mission key opens the execution door (\`/mcp\`, the git remote) only; a browser session opens the web interface only, and only a browser session answers a request or an approval. An agent that prepares missions does it with a mission on its person's Vaubaan account, which never rotates or stops itself nor issues a mission holding a Vaubaan account, so an agent can neither widen its own mission nor approve its own action ([threat model](${gh(THREAT_MODEL)}#the-two-credentials-and-why-they-never-cross); proof: [credential-separation.test.ts](${gh('apps/gateway/tests/integration/execution/credential-separation.test.ts')})).
- **One instance, one company.** The instance runs on your network, behind your identity provider, with the tokens your company made at each service. Whoever operates it holds the master key and can read a decrypted credential in the memory of a running call: the gateway does not defend against its own operator, and makes the operator's acts visible instead ([threat model](${gh(THREAT_MODEL)}#the-trust-proposition), [ADR](${gh('docs/decisions/trust-model-clear-at-rest-idp-style.md')})).

## Controls

- **Encryption at rest.** Each stored credential is sealed with XChaCha20-Poly1305 under a key derived per row from the master key, the row id as associated data; the master key lives in the configuration, never in the database, so a copy of the database alone opens nothing ([threat model, assets](${gh(THREAT_MODEL)}#assets), [crypto module](${gh('apps/gateway/src/server/crypto/aead.ts')})).
- **Master key rotation reseals every credential.** A new key version, then a command that re-encrypts every stored secret under it, with a dry run first ([rotation procedure](/docs/operations/master-key-rotation), [ADR](${gh('docs/decisions/master-key-rotation-reseals-every-blob.md')}), [reseal code](${githubTree('apps/gateway/src/server/reseal')})).
- **Keys stored as digests.** A mission key is shown once to its holder; the store keeps a SHA-256 digest of its 32-character random secret ([threat model, assets](${gh(THREAT_MODEL)}#assets)).
- **Every call decided, fail closed.** The mission's resources first, then every slice of the call must match a permission the mission accepted; an unknown tool, an uncovered slice or a stage that throws refuses the call ([threat model, missions](${gh(THREAT_MODEL)}#missions-and-the-execution-door)).
- **Limits and approvals.** A limit is decided and counted in one transaction, so two calls cannot spend the last credit twice; an approval is bound to the mission, the permission, the tool and a fingerprint of the arguments, and is used once ([approval tests](${gh('apps/gateway/tests/integration/requests/approval.test.ts')})).
- **The instance's own hosting is never a mission resource.** The Railway project or Fly app the gateway runs in, and any resource listed in \`self_resources\`, is refused to every mission ([ADR](${gh('docs/decisions/self-resources-never-reachable-by-a-mission.md')}), [tests](${gh('apps/gateway/tests/integration/execution/self-resources.test.ts')})).
- **Sign-in hardening.** OpenID Connect with PKCE, single-use state and nonce; an unverified email is refused; per-address and instance-wide rate limits on sign-in; host-only \`__Host-\` session cookies that end after one hour without a request and eight hours at most; every mutation origin-checked ([threat model, sign-in](${gh(THREAT_MODEL)}#sign-in-and-the-web-session)).
- **Security headers set by the application** on every response, whatever proxy is in front: a nonce-based Content-Security-Policy, framing refused, \`nosniff\`, a referrer policy, no device permission, HSTS for an https public URL ([handbook](${gh('docs/handbook/configuration.md')}), [code](${gh('apps/gateway/src/server/http/security-headers.ts')})).
- **Every call recorded.** Each call writes one audit entry, allowed or refused, with the permissions it needed and whose key made it; arguments are kept as a fingerprint only; the application cannot edit an entry, and only the retention purge deletes old ones ([audit handbook](${gh('docs/handbook/audit.md')}), [threat model, audit](${gh(THREAT_MODEL)}#audit-logs-telemetry)).

## Supply chain

- **Dependency audit gate.** \`npm audit\` gates every change and every release against a reviewed, dated allowlist ([audit-gate.mjs](${gh('scripts/audit-gate.mjs')})).
- **Lockfile gate.** Every installed package comes from the npm registry, over https, with a sha512 integrity hash, under the name it claims ([lockfile-gate.mjs](${gh('scripts/lockfile-gate.mjs')})).
- **Security checks in CI.** Secret scanning of the whole history (gitleaks), static analysis (Semgrep with the project's own rules), an image scan (Trivy) that fails on a known vulnerability with a fix; every tool pinned by checksum or digest ([coding workflow](${gh('docs/workflow/coding-workflow.md')}#security-checks)).
- **The image is built from source**, on base images pinned by digest, runs as a non-root user and ships no package manager ([Dockerfile](${gh('deploy/docker/Dockerfile')}), [deploy README](${gh('deploy/README.md')}#what-the-image-contains)).
- **Released images, provenance once public.** Every release publishes an image at \`ghcr.io/vaubaan/gateway\` with its SBOM, scanned before it is published. While the repository is private, a release is \`linux/amd64\` only and carries no signed build-provenance attestation (its notes say so); multi-architecture images with a signed attestation come with the public repository. You may also build the image yourself ([release workflow](${gh('.github/workflows/release.yml')}), [how to verify](${gh('deploy/README.md')}#released-images)).

## What leaves an instance

**Nothing about the instance, by default.** The one request a new instance makes on its own is for the **versions feed**: one minute after it starts, then once a day, a \`GET\` of [\`https://vaubaan.com/versions.json\`](/versions.json) with no payload, no query and no identifier (its \`User-Agent\` is \`vaubaan-gateway\`, without a version). The feed lists the released versions and the advisories; the instance compares them with what it runs on its own side, and Settings → Administration → Plugins shows what is behind. Nothing is downloaded or installed from it. \`updates.check: false\` turns it off; \`updates.feed_url\` points it at a copy you host ([ADR](${gh('docs/decisions/plugins-bundled-or-pinned-by-the-operator.md')}), [the request](${gh('apps/gateway/src/server/updates/fetch-feed.ts')})).

Community telemetry is off on a new instance (\`telemetry.enabled\`, default \`false\`), and while it is off the instance makes no request to the collector at all. An administrator who considers turning it on sees the exact body of a report on Settings → Administration → Telemetry before anything is sent. Once it is on, reports go to the project's collector at \`https://telemetry.vaubaan.com/v1/reports\`, or to the collector \`telemetry.collector_url\` names instead ([telemetry handbook](${gh('docs/handbook/telemetry.md')})).

When an operator turns it on, the instance sends one of two levels (\`telemetry.level\`; the default level of an enabled instance is \`usage-stats\`):

**Level \`plugin-health\`** — one report per call a plugin executed, exactly seven fields:

| Field | What it holds |
| --- | --- |
| \`plugin\` | the plugin's id, such as \`github\` |
| \`plugin_version\` | the plugin's version |
| \`gateway_version\` | the gateway's version |
| \`tool\` | the tool's name, only if the plugin declares it |
| \`outcome\` | \`success\`, \`upstream-error\`, \`classification-error\` or \`execution-error\` |
| \`error_class\` | null for a success, else a fixed keyword or \`http_<status>\`; never a message |
| \`duration_bucket\` | \`lt_100ms\`, \`lt_1s\`, \`lt_10s\` or \`gte_10s\` |

**Level \`usage-stats\`** adds:

- one **decision** per call the gateway decided: the plugin, the tool (null when the agent named a tool the plugin does not declare), the gateway version, \`allowed\` or the refusal code, the permissions touched without the environment label your company chose (\`github.git-push\`, never \`github[prod].git-push\`), and whether an approval was involved;
- one **instance profile** per UTC day: the gateway version, the kind of deployment (\`docker\`, \`railway\`, \`fly\` or \`other\`), the runtime and architecture, the kinds of sign-in in use, and counts as buckets only (\`0\`, \`1\`, \`2-5\`, \`6-20\`, \`21-100\`, \`101-1000\`, \`>1000\`) of users, running missions, calls and accounts per plugin, the plugins and their versions; and the **instance identifier**: 128 random bits the gateway draws once and keeps in its store, shown to its administrator on Settings → Administration → Telemetry, who can regenerate it there. It is sent with this daily profile only, never with a call report or a decision, so no call is attributable to an instance; it lets the community count the gateways that run a plugin version over 90 days.

**Never sent, and impossible for the collector to store:** the arguments of a call or a hash of them, payloads, service answers or error text, resource references, environment labels, mission, user or account identifiers, emails, account names, host names, URLs, an identifier of the instance on a call, a network address. No report carries a time; the collector stores the UTC hour a row arrived ([collector README](${gh('deploy/collector/README.md')}#what-an-instance-sends), [schema](${gh('deploy/collector/schema.sql')})).

**Addresses at the collector.** The collector runs on Vercel, as part of this site's project. Vercel records the client address of each request in the project's runtime logs and cannot be told not to; the project has no log drain and no Observability Plus, so an address stays in Vercel's logs for the plan's base window (one day on Pro, one hour on Hobby) and nowhere else. The collector's code never logs a request (its one log line is a count and a result) and forwards no header to its database, which therefore never sees an instance's address ([collector README](${gh('deploy/collector/README.md')}#addresses-what-is-seen-and-how-long), [collector code](${githubTree('apps/website/src/collector')})). The same platform logs apply to visits to this site, which sets no cookie and runs no analytics or third-party script.

**How to check it.** The report is built by one constructor that refuses an extra key ([packages/telemetry](${githubTree('packages/telemetry/src')})); a structural test drives the real call pipeline with planted secrets and asserts that, at level \`plugin-health\`, nothing but the seven fields reaches the wire ([telemetry-report-shape.test.ts](${gh('apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts')})), and unit tests hold the shapes of the \`usage-stats\` reports ([usage.test.ts](${gh('packages/telemetry/src/usage.test.ts')})); every column of the collector's tables is constrained to a closed vocabulary or a bucket ([schema.sql](${gh('deploy/collector/schema.sql')})). To guarantee that no report is ever sent, set \`telemetry.enabled: false\` in the configuration; with \`updates.check: false\` as well, the instance makes no request of its own to the project.

**Plugin health** is published from these reports: calls and success rate per plugin version, the rate leaving out calls refused for a rejected credential, and the number of gateways running each version, counted from the instance identifiers of the profiles; a plugin version is deemed validated with ${thresholdsSentence(thresholds)} ([plugin health](/plugins/health)).

## What is not covered

- **Pre-release, no audit, no certification**, as said above.
- **Out of scope of the threat model:**
${outOfScope.map((item) => `  - ${item}`).join('\n')}
- **Accepted risks** — known, decided, and written down with why each is accepted and what limits it ([threat model](${gh(THREAT_MODEL)}#accepted-risks)):
${acceptedRisks.map((r) => `  - ${r.id}: ${r.statement}`).join('\n')}

## Report a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting: on the repository, the **Security** tab, **Report a vulnerability** ([direct link](https://github.com/vaubaan/gateway/security/advisories/new)); it is the project's only reporting channel. Include the version or commit, what an attacker starts from, the steps or a failing test, and the impact you believe it has; remove real credentials. The project aims to acknowledge a report within a few working days, keeps you informed in the advisory, and publishes it with credit once a fix is available; these are intentions, not commitments ([SECURITY.md](${gh('SECURITY.md')})).
`;
}
