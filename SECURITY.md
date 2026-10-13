# Security policy

Vaubaan Gateway sits between coding agents and cloud providers and holds
provider credentials on behalf of its users. Security reports are taken
seriously and handled privately.

## Supported versions

| Version                 | Status                                              |
| ----------------------- | --------------------------------------------------- |
| 2.x (pre-release, `v5`) | Under construction on the `v5` branch; best effort  |
| v4 SaaS (`v4-final`)    | Historical tag, not maintained, no security support |

Until the first `v2.0.0` release, fixes land on the `v5` integration branch
and reach `main` with it; there is no backport.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting on this repository ("Security"
tab, "Report a vulnerability"). This opens a private security advisory that
only the maintainers can read. Include a reproduction, the affected version
or commit, and what you believe the impact is.

You should receive an acknowledgement within a few days. We will keep you
informed of the fix and credit you in the advisory unless you prefer
otherwise.

## Scope

In scope: anything that lets a mission token do more than its policy
allows, lets an agent read or exfiltrate a provider credential, bypasses
the budget or approval gate, forges a request or approval, tampers with the
audit log, or escalates from one user to another.

Out of scope: vulnerabilities in the upstream providers themselves, in a
specific operator's identity provider configuration, or in deployments that
disable TLS or expose the instance without a reverse proxy.

## Threat model

The security model (encryption at rest, token formats, transport, audit
immutability, what the gateway promises and what it does not) is described
in the specification, section 6: [`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md#6-security).
