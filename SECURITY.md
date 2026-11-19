# Security policy

Vaubaan Gateway sits between coding agents and cloud services and holds
service credentials on behalf of its users. A flaw in it can expose those
credentials or let an agent do more than it was allowed. Security reports are
handled privately and take priority over other work.

## Supported versions

| Version                                                           | Security fixes                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2.0.0 pre-releases (`v2.0.0-alpha.*`, `v2.0.0-rc.*`, from `main`) | Yes. A fix lands on `main` and ships in the next pre-release; nothing is backported to an earlier one. |
| v4 SaaS (tag `v4-final`) or older                                 | No. Historical; not maintained.                                                                        |

Until `v2.0.0`, the supported line is the latest pre-release, cut from `main`:
update to it to receive a fix. From `v2.0.0` on, this table will name the
release lines that receive fixes.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a
vulnerability.**

Report it through GitHub's private vulnerability reporting: on the
repository, open the **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/vaubaan/gateway/security/advisories/new)).
This creates a security advisory that only you and the maintainers can read.
The project has no other reporting channel.

Include what lets us reproduce it:

- the version or commit (`git rev-parse --short HEAD`, or the image tag);
- what an attacker needs to start from (a mission token, a user session,
  network access to the instance, nothing);
- the steps, or a failing test, and what you observed;
- the impact you believe it has;
- for a plugin: the service, the tool, the arguments, and the slice or risk
  you expected.

Remove real credentials and tokens from the report. A token prefix is enough.

## What to expect

These are intentions, not commitments: the project does not guarantee a
response time.

- We aim to acknowledge a report within a few working days.
- We aim to tell you, after a first analysis, whether we consider it a
  vulnerability and how severe.
- We keep you informed in the advisory while the fix is prepared.
- We publish the advisory when a fix is available, and credit you unless you
  prefer otherwise.

Please give us reasonable time to fix the problem before you disclose it.

## Scope

In scope — anything that breaks what the gateway promises:

- a mission doing more than its policy accepts: a call that is **classified
  too leniently by a plugin** (a write seen as a read, a slice that names
  less than the call does), a call reaching a resource outside the mission,
  a risk that should be touched and is not;
- going past a budget, a rate limit or an approval gate; replaying or forging
  an approval or a request;
- an agent, or a plugin's result, reading or exfiltrating a service
  credential, the master key or another secret;
- one credential opening a surface that is not its own (a mission token on
  the interface or granting a request, a session on the execution door);
- a mission acting on itself through its Vaubaan account (rotating or
  revoking itself, issuing a mission that holds a Vaubaan account), or acting
  beyond its creator's authority;
- acting as another user, or keeping an authority after it was revoked or
  after leaving a group;
- changing or deleting audit entries from the application;
- a secret or call arguments written in clear to logs, or a telemetry report
  carrying anything other than what the specification lists;
- flaws in sign-in, sessions, the OAuth authorization server, or the service
  connect flows (replay, redirect, installation not bound to its user).

Out of scope:

- vulnerabilities of the services themselves, of your identity provider, or
  of an MCP client;
- what the trust model below accepts: the operator of an instance, or
  anybody with access to its host, memory, master key or database file;
- an instance deployed against the documentation: without TLS in front,
  exposed without a reverse proxy, or with the demo (`npm run demo`) made
  reachable from a network — the demo has no authentication by design;
- a service credential created broader than the plugin's documentation asks:
  the gateway limits what an agent does with a credential, not the credential
  itself;
- denial of service that needs an authenticated user of the same company;
- findings of automated scanners without a demonstrated impact.

A classification you think is too strict, or a risk whose description is
wrong without letting anything through, is not a vulnerability: use the
"Catalog correction" issue.

## What the project checks

Every instance runs the same image and the same dependencies, so the
project's own supply chain is checked on every change. What runs, when,
and how a finding is triaged: [`docs/workflow/coding-workflow.md`](docs/workflow/coding-workflow.md#security-checks).

- **Secrets**: the whole git history is scanned (gitleaks) on every push of
  a work branch and on every pull request. A secret that was committed is
  revoked at its issuer; the history is not rewritten.
- **Code**: static analysis (Semgrep, community security rules at a pinned
  commit plus rules of this codebase) on every pull request and weekly on
  the default branch. The codebase's rules include: every HTTP call of a
  plugin states its redirect policy (`redirect: 'error'` unless a service
  redirects on purpose), so a credential header never follows a redirect to
  another origin; TLS certificate verification is off in one reviewed place
  only (the attested OAuth broker channel, which compares the key with its
  attestation before it writes). Property-based tests cover the parsers that
  read what an agent or a client sends (SQL, shell, headers, the git wire,
  the configuration).
- **Dependencies**: `npm audit` against a reviewed allowlist, registry
  signatures and provenance (`npm audit signatures`), a lockfile that only
  downloads from the npm registry with an integrity hash, and weekly
  updates that wait a cooldown of several days before a new version is
  adopted. A registry outage lets a merge through with a warning, never a
  release: a release run fails until the audit has answered.
- **Image**: scanned with Trivy on every release, weekly on the default
  branch and on demand (a known vulnerability with a fix fails it), no
  package manager shipped, base image pinned by digest. Dependencies are
  installed and the application built as an unprivileged user, never as
  root; the server runs as uid 10001, and the reference Compose file adds a
  read-only root filesystem, no capability and no new privilege (the smoke
  test runs the image so).
- **Release**: the image carries an SBOM and a signed build-provenance
  attestation that the release pipeline verifies before it publishes;
  verify it yourself before you run it:
  [`deploy/README.md`](deploy/README.md#released-images).

Every tool is pinned by checksum or digest; no scanner runs as a
third-party GitHub Action. A finding of these tools that you believe we
missed is welcome as a report — with its impact on an instance (see Scope:
findings without a demonstrated impact are out of scope).

## Past reviews

No third-party review has happened yet. The code cites the maintainers' own reviews by date and
finding, so that a reader finds why a guard exists:

- **security review 2026-10-15** and **security audit 2026-10-31** (findings `L1`, `M2`…): two
  internal reviews before the repository was made public. A comment cites a finding where the
  code answers it; no report of either is published.
- **2026-11-19**: an internal review of the code, the architecture and the CI/CD. Its fixes are
  in the [changelog](CHANGELOG.md) under that date's entries (plugins' egress, the second-factor
  enrolment, the catalog's release job and signature checks, the plugins' risk classification).

## Trust model

1. **One instance, one company, one trust domain.** Whoever operates the
   instance can reach decrypted credentials in the memory of the running
   process. The gateway does not defend against its own operator.
2. **An agent never holds an account's stored credential.** It holds a
   mission token; the gateway decrypts the credential for the duration of one
   call and returns only the result. No tool hands a service token to the
   agent: the plugin SDK has no way to declare one.
3. **The gateway decides from the plugin's classification.** A call is
   allowed when every risk it touches was accepted by the mission, within its
   budget and gate. A wrong classification is therefore a vulnerability.
4. **Two credentials that never cross**: the mission token executes (an
   agent preparing missions does it with a mission on its person's Vaubaan
   account, which never acts on itself), the human session uses the
   interface. Only a human session grants a request or an approval.
5. **Identity comes from your identity provider; authorization is local.**
   Credentials are encrypted at rest with a key derived per account from a
   master key kept outside the store, the audit log is append-only, and TLS
   is terminated by a proxy you run.

The full statement is section 6 of the specification,
[`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md#6-security);
the reasoning behind the first line is the ADR
[trust-model-clear-at-rest-idp-style](docs/decisions/trust-model-clear-at-rest-idp-style.md).
How each of these is implemented is described in the handbooks under
[`docs/handbook/`](docs/handbook/): [authentication](docs/handbook/authentication.md),
[accounts](docs/handbook/accounts.md),
[execution-door](docs/handbook/execution-door.md),
[services/vaubaan](docs/handbook/services/vaubaan.md) and
[audit](docs/handbook/audit.md). Who can attempt what on each surface, the
control that answers it, the test that proves it and the risks that are
accepted are in the [threat model](docs/handbook/threat-model.md).
