# Roadmap

What the maintainers intend to do next, without dates. The project is pre-release: until a
`v2.0.0` tag exists, any of this can change, and so can the public surfaces it touches. What is
missing today, one line each, is in
[known limitations](docs/handbook/known-limitations.md); this page says which of those gaps are
meant to close.

## Before `v2.0.0`

- **Plugins out of this repository.** Today a plugin is a folder of `plugins/`, registered in the
  gateway's source. The plugin SDK (`@vaubaan/plugin-sdk`) will be published on npm, with a build,
  types and the semver rule already written in the
  [coding workflow](docs/workflow/coding-workflow.md), so that a plugin can be written and tested
  outside the monorepo.
- **English names for the trust levels.** The levels a mission's creator picks for a macro-action
  still carry provisional names in the interface, the catalogs and the SDK. They will be renamed in
  English, while the alpha window allows a breaking rename.
- **Plugin guides.** The [plugin kit](plugins/README.md) teaches writing a plugin inside this
  repository. Guides for writing, testing and publishing one outside it, against the published SDK,
  come with that publication.
- **Security hardening, in progress.** Multi-architecture images (`linux/arm64`) and signed
  provenance on every release, which a private repository could not publish. No third-party security
  review has happened yet. The current state is in [SECURITY.md](SECURITY.md) and the
  [threat model](docs/handbook/threat-model.md).

## Known gaps without a plan yet

From [known limitations](docs/handbook/known-limitations.md); an issue that argues for one of them
is welcome.

- Scope caps (a bound on how much one call may touch) are not enforced.
- `tools/list` filters per service, not per tool.
- No deprovisioning feed from the identity provider, and no tool to move people to a new issuer.
- No "back up now" button.

## Not planned

- **High availability.** One process and one embedded database is a design choice
  ([embedded store](docs/decisions/embedded-store-sqlite-and-migrations.md)); the code keeps a
  larger deployment possible but no work is scheduled for it.
- **Intercepting CLIs and SDKs.** Only MCP traffic, and git through the gateway's remote, pass
  through the gateway.
