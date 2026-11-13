/**
 * The structural suite — its index.
 *
 * A structural test holds a property of the whole product that no single
 * feature owns: "nothing persists a wildcard", "every mutation is audited",
 * "the three credentials never cross". Such a property is lost quietly — by a
 * new table, a new handler, a new plugin — so each one is proven by a test
 * that enumerates what exists (handlers from the source, plugins from the
 * import list, columns from the schema) instead of listing it by hand.
 *
 * The tests live where their harness lives: here for the ones that read the
 * source or the schema, under `tests/integration/**` for the ones that need a
 * running instance, beside the code for a few. This file is what makes them
 * one suite: every invariant the spec names (§10 "Structural", §6) and every
 * one added since, each with the test that proves it. `index.test.ts` fails
 * when
 *
 *   - an invariant has no proof, or a proof names a file that is gone;
 *   - a proof names a test title its file no longer contains (renamed away or
 *     deleted: the invariant would silently lose its proof);
 *   - a test file of this folder is in no invariant (a structural test nobody
 *     can find from the index);
 *   - a bullet of the spec's "Structural" list has no invariant here.
 *
 * To add an invariant: write the test, add the entry, run `index.test.ts`.
 * Handbook: docs/handbook/threat-model.md lists, per threat, the control and
 * the proof; the ids below are the ones it cites.
 */

export interface Proof {
  /** Path from the repository root. */
  readonly file: string;
  /**
   * Titles (or distinctive fragments of a title) of the tests in `file` that
   * prove the invariant. Each must still be the title of a test (or of a
   * `describe`) that RUNS in that file: not a comment, not a skipped or
   * to-do test (`index.test.ts` parses the file).
   */
  readonly tests: readonly string[];
  /**
   * Set when a named test sits under a condition (`describe.skipIf(…)`,
   * `it.runIf(…)`): what it needs, and who runs it with that. The index
   * refuses a conditional proof that does not say so, and the reverse.
   */
  readonly conditional?: string;
}

export interface Invariant {
  readonly id: string;
  /** The property, in one sentence a reader can check a change against. */
  readonly statement: string;
  /** Where it comes from: a spec section, an ADR, or both. */
  readonly source: string;
  /**
   * For an invariant of the spec's §10 "Structural" list: a fragment of that
   * bullet, as written in `docs/spec/vaubaan-gateway.md`.
   */
  readonly specBullet?: string;
  readonly proofs: readonly Proof[];
}

const STRUCTURAL = 'apps/gateway/tests/unit/structural';
const INTEGRATION = 'apps/gateway/tests/integration';
const UNIT = 'apps/gateway/tests/unit';
const SERVER = 'apps/gateway/src/server';

export const INVARIANTS: readonly Invariant[] = [
  // ── Spec §10 "Structural" ──────────────────────────────────────────────────
  {
    id: 'telemetry-shape',
    statement:
      'A telemetry report carries the fields of its kind and nothing else: no argument, no resource ref, no token, no token holder (member id, member email, token name), no label, no stable instance identifier — whatever a plugin returns or throws.',
    source: 'spec §9, §10; ADR telemetry-two-levels-behind-a-vercel-collector',
    specBullet: 'no telemetry report, of either level, contains a forbidden field',
    proofs: [
      {
        file: `${STRUCTURAL}/telemetry-report-shape.test.ts`,
        tests: ['structural: a telemetry report contains none of the forbidden fields (spec §9)'],
      },
      {
        file: `${STRUCTURAL}/telemetry-collector-schema.test.ts`,
        tests: [
          'never reads a request header, never stores an address',
          'publishes aggregates only: anon reads the views, which run with their owner rights',
        ],
      },
    ],
  },
  {
    id: 'git-remote-shares-the-admission',
    statement:
      'The git remote admits a request with the very admission object of the execution door — one key check, one mission, one set of budgets and one audit for both doors, never a second implementation.',
    source: 'spec §4.1 ter, §10; ADR gateway-as-git-remote',
    specBullet: 'the git remote admits with the execution door',
    proofs: [
      {
        file: `${INTEGRATION}/git/git-remote-limits.test.ts`,
        tests: ['the git door admits with the MCP door’s own admission'],
      },
    ],
  },
  {
    id: 'counters-agree-with-audit',
    statement:
      'For every risk of every mission, the session counters equal the number of allowed touches in the audit, under random concurrent load.',
    source: 'spec §3.3, §6 "authoritative, atomic counting", §10; ADR atomic-budget-accounting',
    specBullet: 'session counters agree with the audit',
    proofs: [
      {
        file: `${INTEGRATION}/execution/counters-vs-audit.test.ts`,
        tests: ['structural: session counters agree with the audit'],
      },
      {
        file: `${INTEGRATION}/budget/pipeline-consistency.test.ts`,
        tests: ['after a mixed run, SUM(session_counters) == COUNT(audit allowed) per risk'],
      },
      {
        file: `${INTEGRATION}/store/sessions.test.ts`,
        tests: ['counters and audit agree after a mixed run (structural check)'],
      },
    ],
  },
  {
    id: 'no-hardcoded-config',
    statement:
      'No URL, secret, token or project reference is written in the application, the deployment files, the scripts or the workflows; the one default URL lives in one file.',
    source: 'spec §4.3, §10',
    specBullet: 'no configuration value is hard-coded',
    proofs: [
      {
        file: `${STRUCTURAL}/no-hardcoded-config.test.ts`,
        tests: [
          'scans a meaningful set of files',
          'allows the telemetry default URL only in telemetry-default.ts',
        ],
      },
    ],
  },
  {
    id: 'enumerations-persisted',
    statement:
      'Every persisted restriction and every accepted-risk list is one row per explicit RiskId of the loaded catalog: never a wildcard, never a preset reference.',
    source: 'spec §3.1 "Enumeration", §10; pivot ADR D3',
    specBullet: 'every persisted restriction and `accepted_risks` is an enumerated',
    proofs: [
      {
        file: `${STRUCTURAL}/persisted-enumerations.test.ts`,
        tests: [
          'one row per risk, and the column refuses "" and any wildcard',
          'refuses the risk id %j at the database, behind every repository',
          'no table has a column that could hold a preset',
        ],
      },
      {
        file: `${INTEGRATION}/store/connections-shares.test.ts`,
        tests: [
          'refuses a risk id that is not in the loaded catalog (no wildcard can be persisted)',
          'the schema itself rejects a wildcard even if the catalog check were bypassed',
        ],
      },
      {
        file: `${INTEGRATION}/missions/mission-lifecycle.test.ts`,
        tests: [
          'persists the explicit enumeration: resource ids, policy entries, no preset reference',
        ],
      },
      {
        file: `${SERVER}/shares/service.test.ts`,
        tests: ['and stores nothing: a restriction is explicit ids of this catalog'],
      },
    ],
  },
  {
    id: 'resource-creating-tools-declared',
    statement:
      'The tools after whose success the gateway runs a discovery are declared by their plugin, are MCP tools of it, and are exactly the reviewed table: nothing is inferred from a tool name. Every plugin that declares one reads what it created from the answer, so the mission that made the call reaches it.',
    source: 'ADR created-resources-join-the-mission; spec §0 "Resource", §3.1',
    proofs: [
      {
        file: `${STRUCTURAL}/resource-creating-tools.test.ts`,
        tests: [
          'declares exactly its creating tools, each one of its MCP tools',
          'reads what its creating tools created (createdResources)',
          'every plugin named in the table is shipped',
        ],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/define-plugin.test.ts',
        tests: [
          'resourceCreatingTools is optional; it names MCP tools of the plugin, once each',
          'a plugin that declares resourceCreatingTools reads the created resource (createdResources)',
        ],
      },
    ],
  },
  {
    id: 'plugins-read-through-the-transport',
    statement:
      "A plugin reads its provider's answers through the SDK transport (bounded, typed, guarded), never with .json() or .text() of its own, and never casts an answer to a DTO type.",
    source: 'ADR plugin-contract-and-credential-spec (amendment of 2026-10-31)',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-transport.test.ts`,
        tests: [
          'the checks read a body read and a DTO cast, and nothing else',
          'reads no response body itself',
          "casts no provider's answer to a DTO",
        ],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/transport-http.test.ts',
        tests: [
          'cuts and cancels a body without content-length as soon as it passes the bound',
          '401 and 403 are a rejected credential, quoting the answer ; the query string is never named',
        ],
      },
    ],
  },
  {
    id: 'plugin-names-declared-once',
    statement:
      'A plugin writes its provider id and its tool names once, in src/identity.ts (and declares its tools in src/tools.ts); no other source file writes a tool name or the provider id as a literal.',
    source: 'plugins/README.md step 1 and step 4',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-names-declared-once.test.ts`,
        tests: [
          'writes no tool name and no provider id outside identity.ts and tools.ts',
          'every literal of another meaning is still in its file',
        ],
      },
    ],
  },
  {
    id: 'plugin-identifiers-never-repaired',
    statement:
      'A plugin writes "every instance" with the SDK\'s ANY_IDENT / identSegment, never a copy of its own, and never repairs an identifier by replacing the characters it may not hold.',
    source: 'ADR plugin-identifiers-one-grammar-for-classify-and-execute; plugins/README.md step 4',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-identifier-helpers.test.ts`,
        tests: [
          'the check reads an identifier repair, and not a printable-text filter',
          'declares no ANY_IDENT of its own',
          'replaces no character an identifier may not hold',
        ],
      },
    ],
  },
  {
    id: 'catalogs-on-their-data-model',
    statement:
      "Every live pattern of a shipped catalog, and every slice a plugin test samples, is a path of the plugin's own data model: rooted at a declared entity, each name a child of the one before, a virtual leaf last only.",
    source:
      'risk-model spec §2, §3; ADR plugin-contract-and-credential-spec (amendment of 2026-10-31)',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-data-model-paths.test.ts`,
        tests: ['every live pattern walks its data model'],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/data-model-paths.test.ts',
        tests: [
          'a typo in a pattern is reported with its risk ; a deprecated entry is not read',
          'lists every slice off the model, naming the sample',
        ],
      },
    ],
  },
  {
    id: 'macro-actions-group-the-catalog',
    statement:
      'Every shipped catalog groups each of its live risks but the fallback in exactly one macro-action of its own explicit risks, never a wildcard; no catalog ships presets or declares a macro-action named "anything-else" or "everything-i-hold".',
    source: 'spec §10, §3.2; ADR macro-actions-and-trust-levels-prefill-the-policy',
    specBullet:
      'every catalog groups each of its risks but the fallback in exactly one macro-action, and no catalog ships presets',
    proofs: [
      {
        file: `${STRUCTURAL}/shipped-macro-actions.test.ts`,
        tests: [
          'no catalog source declares presets',
          'ships no presets key',
          'ships at least one macro-action, each with at least one entry',
          'puts each live risk but the fallback in exactly one macro-action',
          'names only explicit risks of its own catalog, never a wildcard',
          'leaves "anything-else" and "everything-i-hold" to the gateway, and names each macro-action once',
        ],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/testing-kit.test.ts',
        tests: ['explicit lists pass, wildcards and sentinels fail'],
      },
    ],
  },
  {
    id: 'authority-never-snapshotted',
    statement:
      'A user’s authority is recomputed from the store at every question — issuance, the owner check, the execution door, the admin rule — and `orphaned` is derived from it at every read, never stored.',
    source: 'spec §2.3, §10; ADR orphaned-missions-and-ownerless-connections',
    specBullet: 'authority on a connection is recomputed',
    proofs: [
      {
        file: `${STRUCTURAL}/authority-not-snapshotted.test.ts`,
        tests: [
          'issuance follows the membership on the very next question',
          'the web session of the last sign-in does not keep an authority alive',
          'the execution door re-reads the creator’s authority on every request',
          'no production source writes the status',
          'every reader of a mission record derives the state or does not read it',
        ],
      },
      {
        file: `${STRUCTURAL}/persisted-enumerations.test.ts`,
        tests: ['`missions.status` cannot hold `orphaned`: the state is derived, never stored'],
      },
      {
        file: `${INTEGRATION}/store/ownership-and-orphans.test.ts`,
        tests: ['missions: `orphaned` is never stored (migration 0007)'],
      },
      {
        file: `${INTEGRATION}/auth/oidc-login.test.ts`,
        tests: ['structural: authority is recomputed from current membership'],
      },
    ],
  },

  // ── Spec §6 and §8, and what was added since ───────────────────────────────
  {
    id: 'every-mutation-audited',
    statement:
      'Every public method of every service that changes something leaves the administrative entry of its act, naming the human behind it (and the delegated client when there is one).',
    source: 'spec §8',
    proofs: [
      {
        file: `${INTEGRATION}/audit/admin-mutations.test.ts`,
        tests: [
          'every public service method is classified: read, mutation or exempt with a reason',
          'covers every mutating act the services can perform',
          '$name writes $rule.writes.act',
        ],
      },
    ],
  },
  {
    id: 'every-mutation-guarded',
    statement:
      'Every mutating route goes through one guard — origin, then session, then role — or is an MCP door or an OAuth protocol endpoint that reads no session; every Administration page and route authorizes by itself.',
    source: 'spec §6 "Every mutation requires a valid session and an origin check"',
    proofs: [
      {
        file: `${UNIT}/server/auth/mutation-guard.test.ts`,
        tests: [
          'classifies every handler of the human surfaces',
          'finds the mutating routes of the app',
          'delegates to a guarded mutation only',
          'refuses a caller with no session, and writes nothing',
          'refuses a session of the wrong role, and writes nothing',
        ],
      },
      {
        file: `${UNIT}/app/admin-guard.test.ts`,
        tests: [
          'finds the pages and the routes of the surface',
          'calls requireOperator() and never reads the bare decision',
        ],
      },
      {
        file: `${UNIT}/app/app-guard.test.ts`,
        tests: ['the human surface authenticates in every page and route'],
      },
    ],
  },
  {
    id: 'three-credentials-never-cross',
    statement:
      'A mission token opens the execution door only, a delegated token the management door only, a human session the interface only; a request is granted in a human session and nowhere else.',
    source: 'spec §2.4, §6 "Separation of the three credentials", §10',
    proofs: [
      {
        file: `${INTEGRATION}/oauth-as/credential-separation.test.ts`,
        tests: [
          'the three credentials never cross over',
          'each credential opens its own door',
          'refuses every kind of mission token alike: a member’s own and a named one open the execution door only',
          'requests are granted only in a human session',
        ],
      },
    ],
  },
  {
    id: 'calls-attributed-to-token-holder',
    statement:
      'Every call through the execution door is attributed to the holder of the token it presented — a member, or a named token — in the audit entry and in the session event, from the authenticated token and never from what the caller declares; every token of a mission draws from one budget; and a token whose member was removed or deactivated, or that was rotated or revoked on its own, is refused at the next call, cache hit or miss.',
    source:
      'spec §0 "Mission token", §3.2, §7.9 bis, §8; ADR mission-members-and-per-holder-tokens',
    proofs: [
      {
        file: `${INTEGRATION}/execution/team-door.test.ts`,
        tests: [
          'two members and a named token share one counter and are attributed separately',
          'the holder is the token’s: nothing a caller sends changes who called',
          'refuses a removed member at the next call; the others keep working',
          'refuses a member the moment their membership row says removed, even if their token row still reads active',
          'refuses a deactivated member at once; reactivated, they generate a new token',
          'refuses a member the moment their user row says removed, before anything else is written',
        ],
      },
      {
        file: `${SERVER}/execution/execution.test.ts`,
        tests: ['remembers nothing: every call asks what the token is worth now'],
      },
      {
        file: 'packages/gateway-core/tests/unit/pipeline.test.ts',
        tests: ['happy path: allowed, result returned, one audit entry with the §8 fields'],
      },
    ],
  },
  {
    id: 'member-token-secret-stays-with-member',
    statement:
      'The secret of a member token is returned once, to the member who generated it, and to nobody else: no API answer read by the creator, no audit entry and no row of the store carries it (the store keeps a hash); a member reads and uses the mission and changes nothing of it, nor answers its requests.',
    source: 'spec §0 "Mission member", "Mission token"; ADR mission-members-and-per-holder-tokens',
    proofs: [
      {
        file: `${INTEGRATION}/missions/team.test.ts`,
        tests: [
          'no answer of any API read by the creator, and no row of the store, carries it',
          'over HTTP: the secret is in the answer to the member who generated it, and in no answer to the creator',
          'cannot %s: not-found, and nothing is written',
          'cannot see or answer the requests of the mission: they are the creator’s',
        ],
      },
      {
        file: `${INTEGRATION}/store/missions.test.ts`,
        tests: [
          'stores a hash, never a secret: no column of a token row can give the bearer back',
          'removing a member revokes their token in the same step, and only theirs',
        ],
      },
    ],
  },
  {
    id: 'management-door-hard-deny',
    statement:
      'The management door cannot answer a request, open a gate, touch a connection or a share, or execute a tool: nothing of the instance but seven mission methods, static catalogs and its own rate-limit keys is reachable from it. Rotation reaches only the missions the calling delegation issued.',
    source: 'spec §4.1 bis; ADR management-door-authorization-server',
    proofs: [
      {
        file: `${INTEGRATION}/management/hard-deny.test.ts`,
        tests: [
          'nothing of the instance is reachable from the door, its tools or its handler',
          'the mission port is a frozen object of exactly the seven methods, bound to the service',
        ],
      },
      {
        file: `${INTEGRATION}/management/management-door.test.ts`,
        tests: ['rotates only what its own delegation issued'],
      },
    ],
  },
  {
    id: 'no-test-file-in-the-build',
    statement:
      'The standalone output, and therefore the image, carries no test, fixture, simulated identity provider or demo launcher of this repository.',
    source: 'docs/handbook/plugin-sdk.md; deploy/docker/smoke.sh step 7',
    proofs: [
      {
        file: `${INTEGRATION}/standalone-plugin-catalogs.test.ts`,
        tests: ['ships no test file: no trace names one and the standalone tree holds none'],
        conditional:
          'needs the standalone build (`npm run build`): `npm run ci` and the CI job `check` build before they test',
      },
      {
        file: 'deploy/docker/smoke.sh',
        tests: ['no test, spec, fixture or demo file inside the image'],
      },
    ],
  },
  {
    id: 'catalog-declares-only-enforced-limits',
    statement:
      'A shipped catalog declares no limit the door does not enforce: an operator never reads a control they do not have.',
    source: 'ADR scope-caps-amplification-axis',
    proofs: [
      {
        file: `${STRUCTURAL}/catalog-caps-enforced.test.ts`,
        tests: [
          '%s declares no unenforced cap',
          'the enforced list is exactly what the code enforces today',
        ],
      },
    ],
  },
  {
    id: 'config-examples-match-the-loader',
    statement:
      'The documented configuration is the accepted one: the handbook’s key table names exactly the keys the loader takes, and the two deployment examples set none of the retired per-provider OAuth-client keys.',
    source: 'spec §4.3; ADR docker-image-and-config-format',
    proofs: [
      {
        file: `${SERVER}/config/keys-doc.test.ts`,
        tests: [
          'has a row for every key the loader accepts',
          'has no row the loader does not accept',
        ],
      },
      {
        file: `${STRUCTURAL}/example-config-providers.test.ts`,
        tests: ['%s', 'the check reads commented and active lines alike'],
      },
    ],
  },
  {
    id: 'one-version-source',
    statement:
      'The gateway version has one source, the root package.json: the build stamp, /healthz, the footer and telemetry all read it.',
    source: 'docs/workflow/coding-workflow.md "One version"',
    proofs: [
      {
        file: `${STRUCTURAL}/version-single-source.test.ts`,
        tests: [
          'is stamped into the build from the root package.json',
          'has the same value in the lockfile',
        ],
      },
    ],
  },
  {
    id: 'versions-feed-data-readable',
    statement:
      'The data of the published versions feed (releases.json, advisories.json) make a feed the gateway reads: semver versions, advisories with a range, a fix and an https link.',
    source: 'docs/decisions/plugins-bundled-or-pinned-by-the-operator.md',
    proofs: [
      {
        file: `${STRUCTURAL}/release-data.test.ts`,
        tests: [
          'lists advisories of the feed shape, each id once',
          'makes, with the released versions, a feed the gateway reads',
        ],
      },
    ],
  },
  {
    id: 'plugin-version-two-places',
    statement:
      "A shipped plugin's version is written in definePlugin and in its package.json, equal; its README states neither the plugin's version nor its catalog's.",
    source: 'plugins/README.md step 9 and step 11',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-versions.test.ts`,
        tests: [
          'has the version of its package.json',
          'states no version in its README, of the plugin or of its catalog',
        ],
      },
    ],
  },
  {
    id: 'deployed-commit-is-known',
    statement:
      'The commit /healthz reports is the one git archive stamped, else the checkout HEAD, else unknown: no build argument or environment variable feeds it.',
    source: 'docs/workflow/coding-workflow.md; deploy/railway.md §5',
    proofs: [
      {
        file: `${STRUCTURAL}/deployed-commit.test.ts`,
        tests: [
          'no build argument or variable names a commit',
          'an archive of a commit carries that commit',
        ],
      },
    ],
  },
  {
    id: 'module-mocks-isolated',
    statement:
      'A test file that replaces a module runs isolated; every other file shares its worker’s module graph, so a mock outside the isolated project would apply or not by the order the files ran in.',
    source: 'vitest.config.ts (ISOLATED_TESTS); docs/tests/integration-tests.md',
    proofs: [
      {
        file: `${STRUCTURAL}/module-mocks-isolated.test.ts`,
        tests: ['replaces a module only in a file of the isolated project'],
      },
    ],
  },
  {
    id: 'no-secret-no-argument-in-logs',
    statement:
      'No log line is handed call arguments or a secret: tokens by prefix, arguments by hash, and the redactor removes every configured secret.',
    source: 'spec §6 "No secret in logs"',
    proofs: [
      {
        file: `${STRUCTURAL}/no-arguments-in-logs.test.ts`,
        tests: [
          'no logger call names call arguments, a request body or a secret',
          'the scan sees what it is meant to see (a planted offence is reported)',
        ],
      },
      {
        file: `${INTEGRATION}/execution/door-http.test.ts`,
        tests: ['writes no secret and no argument to the logs: token by prefix, arguments by hash'],
      },
      {
        file: 'packages/gateway-core/tests/unit/pipeline.test.ts',
        tests: ['the agent reads it whole, the audit entry holds no argument value'],
      },
      {
        file: `${SERVER}/logging/logging.test.ts`,
        tests: ['replaces every configured secret, longest first, also when JSON-escaped'],
      },
    ],
  },
  {
    id: 'audit-immutable',
    statement:
      'The application cannot update or delete an audit entry; only the retention purge removes entries, and only those older than the cutoff.',
    source: 'spec §6 "Immutable audit", §8',
    proofs: [
      {
        file: `${INTEGRATION}/store/audit.test.ts`,
        tests: [
          'rejects an UPDATE on audit rows',
          'rejects a DELETE outside the retention purge',
          'cannot delete rows newer than the cutoff even inside a purge window',
        ],
      },
    ],
  },
  {
    id: 'surface-rate-limits',
    statement:
      'Every surface an unauthenticated or automated caller reaches is rate-limited on the key the spec names: the execution door per mission, connect flows per user, the request page per client address, the token and registration endpoints per client address, the management door per delegation.',
    source: 'spec §6 "Surface rate limits"',
    proofs: [
      {
        file: `${INTEGRATION}/execution/door-http.test.ts`,
        tests: [
          'applies the surface rate limit per mission, not per agent',
          'answers 401 to every wrong secret on a real prefix, never 429, and the agent is never held',
        ],
      },
      {
        file: `${SERVER}/connections/service.test.ts`,
        tests: ['rate-limits connect attempts per user'],
      },
      {
        file: `${INTEGRATION}/requests/request-handlers.test.ts`,
        tests: [
          'answers 429 with Retry-After once the window is spent, before looking at anything',
          'keys a signed-in creator on their session: an anonymous flood never holds them out',
        ],
      },
      {
        file: `${INTEGRATION}/oauth-as/http-surface.test.ts`,
        tests: ['is rate-limited per client address'],
      },
      {
        file: `${INTEGRATION}/management/management-door.test.ts`,
        tests: [
          'the surface limit is per delegation, through the RateLimiter port, on keys of the door',
        ],
      },
    ],
  },
  {
    id: 'approval-binds-what-was-read',
    statement:
      'What an approver reads is what runs: arguments JSON cannot carry are rejected before the fingerprint is taken, and an approval is bound to mission, risk, tool and fingerprint, once.',
    source: 'spec §3.5; packages/gateway-core/src/fingerprint.ts',
    proofs: [
      {
        file: 'packages/gateway-core/tests/unit/pipeline.test.ts',
        tests: ['an argument JSON cannot carry (Infinity) is rejected before any stage'],
      },
      {
        file: 'packages/gateway-core/tests/unit/fingerprint.test.ts',
        tests: [
          'is why the fingerprint cannot be trusted on such a value: Infinity and null collide',
        ],
      },
      {
        file: `${INTEGRATION}/execution/door-http.test.ts`,
        tests: ['rejects a call whose arguments JSON cannot carry (`1e999`)'],
      },
    ],
  },
  {
    id: 'every-slice-covered',
    statement:
      'A call is allowed only when every slice it executes matches a catalog entry and every risk touched is accepted: no slice, no risk, an uncovered slice and a missing catalog all refuse (a classifier that throws: see every-refused-call-audited).',
    source: 'spec §3.1, §6',
    proofs: [
      {
        file: 'packages/policy-engine/tests/unit/risk-runtime.test.ts',
        tests: [
          'a slice no catalog entry matches denies the call, although another slice is covered and accepted',
          'a slice of another provider is not dropped: it denies',
          'no slice → deny (classification gap)',
        ],
      },
    ],
  },
  {
    id: 'every-refused-call-audited',
    statement:
      'Every call the execution door refuses leaves its audit entry, including the one refused because a decision stage threw (a classifier that is not total, a store failure): the entry names the stage and the class of the error, never its text.',
    source: 'spec §8 ("one immutable entry per MCP call, allowed or refused"); spec §6',
    proofs: [
      {
        file: 'packages/gateway-core/tests/unit/pipeline.test.ts',
        tests: [
          'a classifier that throws: one audit entry, no budget, no upstream, no message kept',
          'the resource stage throws: audited with no target',
          'the budget stage throws: audited with the risks the call touched, nothing forwarded',
          'the audit write of that refusal failing still propagates',
        ],
      },
      {
        file: `${INTEGRATION}/execution/pipeline.test.ts`,
        tests: [
          'a classifier that throws: the call is refused, AUDITED, counted nowhere, and its text reaches neither the audit nor the log',
        ],
      },
    ],
  },
  {
    id: 'plugin-identifiers-shared-grammar',
    statement:
      'In every plugin, an identifier that reaches a path, a query, a header, a GraphQL variable, an SQL text or a command is validated by one grammar shared by classify and execute, which refuses instead of escaping: what is executed is what was classified.',
    source: 'ADR plugin-identifiers-one-grammar-for-classify-and-execute',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-identifier-tests.test.ts`,
        tests: [
          '%s has a test feeding hostile identifiers to classify and to execute',
          '%s runs the identifier proof of the SDK kit',
        ],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/identifiers-kit.test.ts',
        tests: [
          'passes a plugin whose classify and execute share one grammar, and says what it ran',
          'finds a grammar applied in classify only : refused, yet sent',
          'finds a dot segment that escaping left in place, and accepts what escaping names exactly',
          'refuses to pass on nothing : no identifier seen in a path must be stated, with its reason',
        ],
      },
      {
        file: 'plugins/github/tests/unit/injection.test.ts',
        tests: ['identifier positions — classify and execute agree on every hostile value'],
      },
      {
        file: 'plugins/gmail/tests/unit/injection.test.ts',
        tests: ['identifier positions — hostile values'],
      },
      {
        file: 'plugins/ssh/tests/unit/injection.test.ts',
        tests: ['cmd — what is sent is what was classified'],
      },
      {
        file: 'plugins/vercel/tests/unit/identifier-injection.test.ts',
        tests: ['vercel identifiers — the dot-segment reproductions'],
      },
      {
        file: 'plugins/railway/tests/unit/identifier-injection.test.ts',
        tests: ['railway identifiers — execute runs on the target the classifier resolved'],
      },
      {
        file: 'plugins/supabase/tests/unit/identifier-injection.test.ts',
        tests: ['supabase identifiers — the dot-segment reproductions'],
      },
      {
        file: 'plugins/stripe/tests/unit/identifiers.test.ts',
        tests: ['`id` — a segment of the request path'],
      },
      {
        file: 'plugins/resend/tests/unit/identifiers.test.ts',
        tests: ['a contact selector — an id or an email address in the request path'],
      },
      {
        file: 'plugins/resend/tests/unit/addresses.test.ts',
        tests: ['a string that could carry a second recipient is not an address'],
      },
      {
        file: 'plugins/cloudflare-dns/tests/unit/identifiers.test.ts',
        tests: ['`record_id` — the record segment of the request path'],
      },
      {
        file: 'plugins/context7/tests/unit/execute.test.ts',
        tests: ['hostile identifiers : what classify refuses, execute does not send'],
      },
      {
        file: 'plugins/context7/tests/unit/plugin.test.ts',
        tests: ['hostile identifiers are refused by classify and by execute, or never reach a URL'],
      },
      {
        file: 'plugins/miro/tests/unit/identifiers.test.ts',
        tests: [
          '`board` and `item_id` — what classify refuses, execute does not send, and the URL sent is the gateway’s',
        ],
      },
      {
        file: 'plugins/upstash-redis/tests/unit/identifiers.test.ts',
        tests: ['the database — a segment of the Management API path'],
      },
      {
        file: 'plugins/notion/tests/unit/identifiers.test.ts',
        tests: [
          'the root : refused when malformed, whatever the mission holds',
          'the undashed spelling is named in the canonical form, in the slice and in the path',
        ],
      },
      {
        file: 'plugins/asana/tests/unit/identifiers.test.ts',
        tests: [
          'an accepted gid is named exactly in the path, and the slice',
          'a resource ref outside the grammar is refused on both sides, even when it is in the mission',
        ],
      },
      {
        file: 'plugins/_template/tests/unit/plugin.test.ts',
        tests: [
          'an identifier that is not one path segment is refused, never escaped',
          "execute applies the classifier's identifier check : nothing is sent for an unsafe id",
        ],
      },
    ],
  },
  {
    id: 'no-secret-in-a-build-upload',
    statement:
      'The image build context and the upload of `railway up` both exclude env files, keys, the mounted YAML configuration and the agent and operator directories.',
    source: 'security review 2026-10-15 (secrets-and-infra M5); deploy/railway.md §5',
    proofs: [
      {
        file: `${STRUCTURAL}/upload-ignore-files.test.ts`,
        tests: [
          'build uploads exclude every secret-bearing path',
          '.railwayignore excludes the root env files explicitly too',
        ],
      },
    ],
  },
  {
    id: 'base-images-pinned',
    statement:
      'Every base image is pinned by full version and digest, the documentation quotes the pinned versions, and the refresh procedure is written down.',
    source: 'ADR docker-image-and-config-format; docs/workflow/coding-workflow.md',
    proofs: [
      {
        file: `${STRUCTURAL}/base-images-pinned.test.ts`,
        tests: [
          'the Dockerfile builds every stage from the one pinned base image',
          'the Compose file pins every image it pulls',
          'the refresh procedure is written down where the pins point to',
        ],
      },
    ],
  },
  {
    id: 'dependency-audit-reviewed',
    statement:
      'A production advisory fails CI unless a dated, reasoned allowlist entry names it; an entry is never a wildcard and lapses after about a quarter; a registry outage is never read as an advisory.',
    source: 'docs/workflow/coding-workflow.md "Dependency audit"',
    proofs: [
      {
        file: 'scripts/audit-gate.test.mjs',
        tests: [
          'fails on a gated advisory the allowlist does not name; a low one is a notice',
          'fails once the review date has passed: an allowlist entry is a dated decision, not a mute',
          'registry-error, to retry',
          'is valid: every entry has a reason and a review date',
        ],
      },
    ],
  },
  {
    id: 'shipped-token-guides',
    statement:
      'Every plugin the image ships with a token way links the token page, lists steps to act on ending at the paste, says how wide to grant and that the mission narrows it, says who knows the expiry, points to the service documentation, and checks the token at paste: no token plugin ships with a bare form.',
    source: 'ADR one-place-to-authorize-services-token-first (amended 2026-10-31)',
    proofs: [
      {
        file: `${STRUCTURAL}/token-guides.test.ts`,
        tests: [
          'links the token page and names what the person creates',
          'lists steps to act on, the last one at the paste',
          'says how wide to grant and that the mission narrows it',
          'says who knows the expiry',
          'checks the token at paste and never shows it back',
        ],
      },
    ],
  },
  {
    id: 'connect-screenshots-declared',
    statement:
      "Every screenshot a shipped plugin's connect guide declares is a file of its docs/connect folder, a PNG or a WebP by its magic bytes, at most 300 KB and 1600 px wide, and no undeclared file sits in that folder; its source, licence (an allowlist without NonCommercial or NoDerivatives), month and alt text are checked by definePlugin.",
    source: 'ADR plugin-contract-and-credential-spec (amendment 2026-11-13)',
    proofs: [
      {
        file: `${STRUCTURAL}/connect-screenshots.test.ts`,
        tests: [
          'reads the headers it relies on',
          'finds the declared screenshots',
          '%s: %s is a light PNG or WebP of at most 1600 px',
          'plugins/%s/docs/connect holds only declared files',
        ],
      },
    ],
  },
  {
    id: 'shipped-plugin-icons',
    statement:
      'Every plugin the image ships declares the icon the interface shows it by (the path data of one SVG path on a 24-unit grid) and the brand colour it is drawn in: no service of the repository falls back to two letters or to the plain ink, and the interface keeps no provider → icon or colour list of its own.',
    source: 'ADR service-icons-declared-by-the-plugin; style-guide §5 "Service mark"',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-icons.test.ts`,
        tests: [
          'declares an icon: the path data of one SVG path',
          'declares the brand colour it is drawn in: one #RRGGBB',
          'draws it on the 24-unit grid: no coordinate far outside it',
        ],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/define-plugin.test.ts',
        tests: [
          'icon is optional, and the path data of one SVG path when present',
          'iconColor is optional, and one #RRGGBB colour when present',
        ],
      },
    ],
  },
  {
    id: 'shipped-plugin-page-declarations',
    statement:
      'Every plugin the image ships declares what its public page shows: a narrative per macro-action of its catalog (two to four sentences, at most 600 characters), its tool samples as `examples` (one per tool, each with its resources), and the tools the risk model leaves out as `excludedTools`, which its classifier refuses by name.',
    source:
      'ADR plugin-contract-and-credential-spec, amendment 2026-11-05; spec gateway-risk-model §4.6, §7.2, §15',
    proofs: [
      {
        file: `${STRUCTURAL}/plugin-narratives.test.ts`,
        tests: ['every macro-action of a shipped catalog has a narrative'],
      },
      {
        file: `${STRUCTURAL}/plugin-examples.test.ts`,
        tests: [
          'has a sample for each of its tools',
          'names the resources of every sample, so the site classifies it as the tests do',
        ],
      },
      {
        file: `${STRUCTURAL}/plugin-excluded-tools.test.ts`,
        tests: ['declares the tools spec §7.2 leaves out', 'refuses every excluded tool by name'],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/catalog-loader.test.ts',
        tests: ['a narrative that is not a string of at most 600 characters refuses the catalog'],
      },
      {
        file: 'packages/plugin-sdk/tests/unit/define-plugin.test.ts',
        tests: [
          'excludedTools is optional; it names tools the plugin does not declare, one sentence each',
          'examples is optional; it maps tools of the plugin to well-formed sample calls',
        ],
      },
    ],
  },
  {
    id: 'cookies-host-prefixed',
    statement:
      'The session and pending sign-in cookies carry the __Host- prefix with what it requires (Secure, Path=/, no Domain), HttpOnly and SameSite=Lax.',
    source:
      'spec §6 "Web sessions are short and bound to the instance’s origin"; docs/handbook/authentication.md',
    proofs: [
      {
        file: `${SERVER}/auth/session-service.test.ts`,
        tests: [
          'names both cookies with the __Host- prefix and keeps what the prefix requires',
          'refuses to write a __Host- cookie on another path',
          'matches the cookie name exactly: a look-alike name a sibling subdomain can set is not the session',
          'reads no session when the name appears twice',
        ],
      },
    ],
  },
  {
    id: 'broker-key-pinned-before-write',
    statement:
      'The attested OAuth broker channel, the one place certificate verification is off, compares the key a socket presents with the pinned attested key before the broker key is written; nothing else writes to the socket.',
    source:
      'ADR google-calendar-through-an-oauth-broker; security audit 2026-10-31 (H2); .semgrep/vaubaan.yml vaubaan-tls-verification-off',
    proofs: [
      {
        file: `${STRUCTURAL}/broker-key-pinned-before-write.test.ts`,
        tests: [
          'turns certificate verification off in one place of the server',
          'writes the key from exchange only when asked, and only send asks',
          'compares every socket send opens with the pin, right after it opens',
          'writes to no socket but through exchange',
        ],
      },
      {
        file: `${SERVER}/connections/oauth-broker.test.ts`,
        tests: ['a key the broker presents and no attestation carries gets nothing'],
      },
    ],
  },
  {
    id: 'ops-stats-counts-only',
    statement:
      'GET /ops/stats does not exist without ops.token, refuses a missing or wrong bearer without saying more, and answers counts only: never a name, an e-mail, an identifier of an item, a resource or a configuration value.',
    source: 'spec §4.3 bis "Counters"; docs/handbook/limits-and-counters.md',
    proofs: [
      {
        file: `${SERVER}/http/ops-stats.test.ts`,
        tests: [
          'does not exist without ops.token: 404, whatever is presented',
          'refuses %s with 401 and says nothing more',
          'in setup mode: 404 without a token, 401 with a wrong one, else 503 setup',
        ],
      },
      {
        file: `${INTEGRATION}/limits/ops-stats.test.ts`,
        tests: [
          'answers the counts of the instance to the bearer of ops.token, and only to them',
          'the endpoint does not exist',
        ],
      },
    ],
  },
  {
    id: 'lookups-keyed-by-parent',
    statement:
      'A mission token, a share and the arguments a request holds are read and changed only with their parent (mission, connection, mission): no repository method takes their id alone.',
    source: 'Security audit 2026-10-31, L8; handbook store',
    proofs: [
      {
        file: `${STRUCTURAL}/keyed-lookups.test.ts`,
        tests: [
          'a token, a share and held arguments take a key with their parent, never an id alone',
          'the repositories name the parent in every statement that reads or changes one by its id',
        ],
      },
    ],
  },
  {
    id: 'named-package-barrels',
    statement:
      'The barrels of @vaubaan/shared, @vaubaan/gateway-core, @vaubaan/policy-engine and @vaubaan/telemetry name every export: no `export *`, so a change of a package contract is a visible line.',
    source: 'Packages audit 2026-10-31, F5; handbook gateway-core',
    proofs: [
      {
        file: `${STRUCTURAL}/named-barrels.test.ts`,
        tests: ['names every export, none with export *'],
      },
    ],
  },
  {
    id: 'client-imports-no-server-value',
    statement:
      'A client component imports no value from src/server (types only), and the pure rules the forms run (src/lib/authority, missions, providers, shares) import no value from src/server.',
    source: 'Packages audit 2026-10-31, F6; handbook web-app',
    proofs: [
      {
        file: `${STRUCTURAL}/client-imports.test.ts`,
        tests: [
          'a client component imports no value from src/server',
          'the pure rules of src/lib import no value from src/server',
        ],
      },
    ],
  },
  {
    id: 'no-french-vocabulary',
    statement:
      'The repository speaks English: no file names the trust level, its tier or the three levels by their first, French names, except the changelog, the applied migrations that stored them and the History of their ADR.',
    source:
      'ADR macro-actions-and-trust-levels-prefill-the-policy, History (owner decision of 2026-10-31)',
    proofs: [
      {
        file: `${STRUCTURAL}/no-french-vocabulary.test.ts`,
        tests: [
          'scans a meaningful set of files',
          'no scanned file names a trust level, a tier or a level in French',
        ],
      },
    ],
  },
  {
    id: 'brokered-scopes-in-provider-table',
    statement:
      'Every shipped plugin whose oauth2 credential takes its client from a broker names a provider of the OAuth provider table the broker compiles in, and asks it only for scopes that provider allows; the gateway refuses to boot otherwise, and the broker runs a byte-identical copy of the table.',
    source: 'Spec oauth-broker §4; ADR oauth-brokers-managed-in-settings-with-two-client-sources',
    proofs: [
      {
        file: `${STRUCTURAL}/brokered-scopes-in-provider-table.test.ts`,
        tests: [
          'names a provider of the table',
          'asks only for scopes the table allows that provider',
        ],
      },
      {
        file: 'apps/gateway/src/server/compose/brokered-plugins-check.test.ts',
        tests: ['stops the boot, naming the plugin'],
      },
      {
        file: 'apps/oauth-broker/tests/unit/provider-table-copy.test.ts',
        tests: ['is a byte-identical copy of packages/oauth-providers/src/providers.ts'],
      },
    ],
  },
];
