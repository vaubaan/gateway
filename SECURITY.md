# Security policy

Vaubaan Gateway sits between coding agents and cloud providers and holds
provider credentials on behalf of its users. A flaw in it can expose those
credentials or let an agent do more than it was allowed. Security reports are
handled privately and take priority over other work.

## Supported versions

| Version                           | Security fixes                                     |
| --------------------------------- | -------------------------------------------------- |
| 2.x, pre-release (`v5` branch)    | Yes, on the `v5` branch. No release is tagged yet. |
| v4 SaaS (tag `v4-final`) or older | No. Historical; not maintained.                    |

Until the first `v2.0.0` release there is one supported line: the head of the
`v5` integration branch. A fix lands there and reaches `main` with it; nothing
is backported. Once releases exist, this table will name the release lines
that receive fixes.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a
vulnerability.**

Report it through GitHub's private vulnerability reporting: on the
repository, open the **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/sbw-vaubaan/vaubaan-gateway/security/advisories/new)).
This creates a security advisory that only you and the maintainers can read.
The project has no other reporting channel.

Include what lets us reproduce it:

- the version or commit (`git rev-parse --short HEAD`, or the image tag);
- what an attacker needs to start from (a mission token, a user session, a
  delegated token, network access to the instance, nothing);
- the steps, or a failing test, and what you observed;
- the impact you believe it has;
- for a plugin: the provider, the tool, the arguments, and the slice or risk
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
- an agent, or a plugin's result, reading or exfiltrating a provider
  credential, the master key or another secret;
- one credential opening a surface that is not its own (a mission token on
  the management door or the interface, a delegated token on the execution
  door, either one granting a request);
- acting as another user, or keeping an authority after it was revoked or
  after leaving a group;
- changing or deleting audit entries from the application;
- a secret or call arguments written in clear to logs, or a telemetry report
  carrying anything other than what the specification lists;
- flaws in sign-in, sessions, the OAuth authorization server, or the provider
  connection flows (replay, redirect, installation not bound to its user).

Out of scope:

- vulnerabilities of the providers themselves, of your identity provider, or
  of an MCP client;
- what the trust model below accepts: the operator of an instance, or
  anybody with access to its host, memory, master key or database file;
- an instance deployed against the documentation: without TLS in front,
  exposed without a reverse proxy, or with the demo (`npm run demo`) made
  reachable from a network — the demo has no authentication by design;
- a provider credential created broader than the plugin's documentation asks:
  the gateway limits what an agent does with a credential, not the credential
  itself;
- denial of service that needs an authenticated user of the same company;
- findings of automated scanners without a demonstrated impact.

A classification you think is too strict, or a risk whose description is
wrong without letting anything through, is not a vulnerability: use the
"Catalog correction" issue.

## Trust model

1. **One instance, one company, one trust domain.** Whoever operates the
   instance can reach decrypted credentials in the memory of the running
   process. The gateway does not defend against its own operator.
2. **An agent never holds a provider credential.** It holds a mission token;
   the gateway decrypts the credential for the duration of one call and
   returns only the result.
3. **The gateway decides from the plugin's classification.** A call is
   allowed when every risk it touches was accepted by the mission, within its
   budget and gate. A wrong classification is therefore a vulnerability.
4. **Three credentials that never cross**: the mission token executes, the
   delegated token manages missions, the human session uses the interface.
   Only a human session grants a request or an approval.
5. **Identity comes from your identity provider; authorization is local.**
   Credentials are encrypted at rest with a key derived per connection from a
   master key kept outside the store, the audit log is append-only, and TLS
   is terminated by a proxy you run.

The full statement is section 6 of the specification,
[`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md#6-security);
the reasoning behind the first line is the ADR
[trust-model-clear-at-rest-idp-style](docs/decisions/trust-model-clear-at-rest-idp-style.md).
How each of these is implemented is described in the handbooks under
[`docs/handbook/`](docs/handbook/): [authentication](docs/handbook/authentication.md),
[connections](docs/handbook/connections.md),
[execution-door](docs/handbook/execution-door.md),
[management-door](docs/handbook/management-door.md) and
[audit](docs/handbook/audit.md). Who can attempt what on each surface, the
control that answers it, the test that proves it and the risks that are
accepted are in the [threat model](docs/handbook/threat-model.md).
