# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Changed

- **Repository reshaped for v5 (P0.1).** `packages/web` is now
  `apps/gateway` (`@vaubaan/gateway-app`), `packages/mcp-gateway` is
  `packages/gateway-core` (`@vaubaan/gateway-core`) and every provider moved
  from `packages/providers/<p>` to `plugins/<p>` (`@vaubaan/plugin-<p>`).
  npm workspaces are `apps/*`, `packages/*`, `plugins/*`. No behaviour
  change; the same 1301 tests pass.
- Licence changed from proprietary to **Apache-2.0**; package version set to
  `2.0.0-alpha.0`.
- Root OSS files added: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue templates, pull request template.
- `README.md` replaced by a short English stub while v5 is under
  construction; the last v4 SaaS release is tag `v4-final`.
- v4 documents written for the SaaS are marked `status: legacy` (ADRs and
  handbooks in place, wholesale-replaced specs and handbooks moved to
  `docs/**/legacy/`).

### Removed

- Supabase migrations and configuration (`supabase/`), the Supabase
  migrations workflow, `vercel.json`, the v4 operator `.env.example`, and
  the Supabase/Vercel-only scripts under `scripts/`. v5 ships as a single
  on-prem process with an embedded store.

[Unreleased]: https://github.com/sbw-vaubaan/vaubaan-gateway/compare/v4-final...HEAD
