# Roadmap

What the maintainers intend to do next, without dates. The project is pre-release: until a
`v2.0.0` tag exists, any of this can change, and so can the public surfaces it touches. What is
missing today, one line each, is in
[known limitations](docs/handbook/known-limitations.md); this page says which of those gaps are
meant to close.

## Before `v2.0.0`

- **Plugins out of this repository, the rest of the way.** The SDK (`@vaubaan/plugin-sdk`) and the
  kit (`@vaubaan/plugin-cli`) are on npm, and a plugin of any repository reaches every gateway
  through the [catalog](https://github.com/vaubaan/gateway-plugins). Left: the SDK's 1.0 (its
  deprecated aliases removed), and moving the official plugins' sources out of `plugins/`.
- **English names for the trust levels.** The levels a mission's creator picks for a macro-action
  still carry provisional names in the interface, the catalogs and the SDK. They will be renamed in
  English, while the alpha window allows a breaking rename.
- **Plugin guides.** `npx @vaubaan/plugin-cli init` scaffolds a plugin outside this repository and
  `submit` declares it in the catalog; a guide that walks through both, end to end, comes next.
- **Security hardening, in progress.** Every release ships `linux/amd64` and `linux/arm64` images
  with an SBOM and a signed provenance. Next: plugins out of the gateway's process (today a plugin
  runs beside every decrypted credential, its signature the boundary), and a third-party security
  review, which has not happened yet. The current state is in [SECURITY.md](SECURITY.md) and the
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
