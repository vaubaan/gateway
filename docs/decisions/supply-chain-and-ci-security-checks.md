---
title: Supply chain and CI security checks — pinned tools, no third-party account, cheap gates on every push
status: accepted
date: 2026-10-13
extends:
  - dependency-audit-gate
  - repository-layout-and-contribution-workflow
  - docker-image-and-config-format
---

# Supply chain and CI security checks — pinned tools, no third-party account, cheap gates on every push

> Feature PN. Procedures: [coding-workflow](../workflow/coding-workflow.md),
> "Security checks", "Dependency updates", "Refreshing the security tools";
> operators: [`deploy/README.md`](../../deploy/README.md), "Verify what you
> pulled"; threat model: "Build, image, supply chain".

## Context

On-prem removes the central honeypot of a hosted gateway, but every instance
installs the same image and the same npm dependencies: the project's supply
chain is now the concentrated target. Already in place: actions pinned by
commit, the `npm audit` gate ([dependency-audit-gate](dependency-audit-gate.md)),
an SBOM and a Sigstore build-provenance attestation in the release workflow,
`SECURITY.md`.

Constraints of the owner (2026-10-14): the repository is private on GitHub
Free — no CodeQL / Advanced Security, no branch protection or rulesets;
2 000 Actions minutes a month; no third-party service that needs an account
or a GitHub App without the owner's agreement. In March 2026 the tags of
`aquasecurity/trivy-action` and `setup-trivy` were moved to malicious
commits: a security tool is itself supply chain.

## Decision

**D1 — Every tool is a release archive pinned by its SHA-256, or an image
pinned by digest; never a third-party action.** `scripts/fetch-tool.sh`
holds the version and the hash of gitleaks, Trivy and actionlint per
architecture and runs nothing whose hash differs. Semgrep runs from
`semgrep/semgrep:<version>@sha256:…`, with `--network none`. A tool version
is adopted only once it is a week old.

**D2 — Secrets: gitleaks over the whole history on every push.** `ci.yml`
(`main`, `v5`, pull requests) and `secrets.yml` (every other branch); the
whole history every time — seconds — rather than the pushed range, which a
force-push or a new branch would miss. Exceptions are reviewed and exact
(`.gitleaks.toml`: a value or a file, never a directory or a rule;
`.gitleaksignore`: fingerprints of deleted files); a fake secret in a test
carries `0123456789` and needs none. A committed secret is revoked, not
rewritten out of history.

**D3 — Static analysis: Semgrep, OSS rules at a pinned commit, plus this
codebase's rules.** The community security rules for JavaScript/TypeScript,
React, Node crypto, JOSE/JWT, sandboxes, MCP servers and Dockerfiles are
read from a checkout of `semgrep/semgrep-rules` at a pinned commit — never
the registry at run time, so a rule change never fails an unrelated pull
request, and no `semgrep login`. One rule is excluded
(`html-in-template-string`: the two server-rendered documents escape with
`escapeHtml`, everything else is React). `.semgrep/vaubaan.yml` holds six
rules — no `process.env` in plugins, no dynamic code, `child_process` only
in tooling, ciphers and key derivation only in the crypto module, no
MD5/SHA-1 (git's own formats excepted), no secret-named value passed to a
logger — and their test cases, run before each scan. A finding is fixed or
suppressed on its line with `nosemgrep: <rule> -- <why>`.

**D4 — Image: Trivy on the built image, gating fixed HIGH/CRITICAL.** In the
`docker` job of every CI run and on each architecture of a release before
anything is pushed or attested: a HIGH or CRITICAL vulnerability **with a
fixed version**, in the Debian or the npm packages of the image, fails. One
without a fix is listed, not gated — nothing could be done but drop the
package. Exceptions in `.trivyignore.yaml`: one id, one package (purl), a
statement and an expiry at most a quarter away. The runner stage ships no
package manager (npm, npx, corepack, yarn): the first scan found every
fixable npm-layer finding inside the npm of the base image.

**D5 — Dependencies: no new dependency to check dependencies.**
`npm audit signatures` after `npm ci` (registry signatures and provenance
attestations of what was installed) and `scripts/lockfile-gate.mjs` — the
checks of lockfile-lint (npmjs registry only, https, sha512 integrity, the
tarball is the package named) in sixty lines, so the gate adds nothing to
the tree it guards. Socket.dev's CLI needs an account and an API token: not
wired (owner's decision, below).

**D6 — Updates: Dependabot, weekly, grouped, with a cooldown.** npm (minor
and patch grouped by production / development; a major alone), the
Dockerfile base, the Compose file and the actions. Cooldown 4 to 14 days:
never a version published in the last 72 hours. Dependabot does not read
`ARG` values, so the base image moves from `ARG NODE_IMAGE` to the `FROM …
AS base` line, same version and digest. Dependabot is a GitHub feature, not
an App; it reads its file from the default branch, so it starts at the
cutover.

**D7 — Parsers of untrusted input get seeded property tests.** fast-check
(dev dependency) on the SQL and shell readers, the door headers, the git
wire and the configuration loader; a fixed seed and 300 cases per property,
`FC_SEED` / `FC_RUNS` to replay or widen.

**D8 — The release verifies its own attestation.** Right after
`actions/attest`, `gh attestation verify` is run on the digest exactly as an
operator would (repository, signer workflow, source ref); the aliases and
the GitHub release need its output. A skipped or quiet attestation step
fails the release instead of publishing an image nobody can verify.

**D9 — Minutes.** The heavy scans run where CI already runs (pull requests
and pushes to `main` / `v5`, the release) and on a weekly schedule of
`ci.yml` that runs the security jobs only; work branches get the secret scan
alone.

## Consequences

- First runs (2026-10-14): gitleaks 23 findings over 655 commits, all test
  fixtures or a type name (reviewed into the allowlist); Semgrep 27, of
  which **two true positives fixed** — glob matching by backtracking regex in
  the SSH classifier (22 stars: 48 s of a blocked process) and in the slice
  matcher, now `matchWildcard` — and 25 justified inline, plus two in the
  git remote after its merge; Trivy 18 fixable, seven of them in the base
  image's npm (removed) and seven in `perl-base` awaiting the base image
  rebuild (expiring exceptions); the property tests found three loader
  crashes (fixed).
- CI minutes: about +3 per CI run (secrets under 1, sast about 1.5 with the
  image pull, Trivy about 1 inside `docker`), +1 per push of a work branch,
  about 6 a week for the schedule; within the plan at the current pace
  (estimate in the coding workflow).
- Reproducibility is unchanged: the base image is still one pinned digest;
  security patches of Debian arrive through the weekly digest refresh, not
  through `apt-get upgrade` at build time.
- The scheduled run and Dependabot need the workflow files on the default
  branch: both start at the cutover of `v5` to `main`.
- Code scanning results are not uploaded as SARIF (no Advanced Security on
  a private Free repository): findings are read in the job log.

## Rejected alternatives

- **`aquasecurity/trivy-action`, `gitleaks/gitleaks-action`,
  `returntocorp/semgrep-action`.** A third-party action runs with the job's
  token and is moved by its tag; Trivy's was hijacked in 2026. The
  gitleaks action also needs a paid licence for an organisation.
- **Semgrep registry rule packs (`p/typescript`, `p/nodejs`…).** Fetched at
  run time, unpinned, and without `semgrep login` the packs gave 74 rules
  and no finding; the pinned folders gave 240 and the true positives.
- **Renovate.** Its ARG-aware Dockerfile manager and `minimumReleaseAge` are
  better, but it needs the Mend App or a self-hosted run with a token: an
  App install the owner has not agreed to.
- **Socket.dev.** Its GitHub App and CLI need an account; listed for the
  owner.
- **`apt-get upgrade` in the runner stage.** Would clear Debian fixes before
  the Node image is rebuilt, but the same commit would build different
  images on different days; rejected for now, a question for the owner.
- **Grype instead of Trivy.** Equivalent coverage; Trivy's ignore file with
  purl scoping and expiry dates decided it.
- **Scanning only the pushed range for secrets.** Misses force-pushes and
  new branches; the whole history costs seconds.
