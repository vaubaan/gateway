# Roadmap

What the maintainers intend to do next, without dates. The project is pre-release: until a
`v2.0.0` tag exists, any of this can change, and so can the public surfaces it touches.

- **What comes next** is the set of `proposed` intents in [`docs/intents`](docs/intents/README.md):
  each says what a person will be able to do and how to tell it is done. Maintainers record the
  work they defer there, never in issues.
- **What is missing today**, one line each, is in
  [known limitations](docs/handbook/known-limitations.md). To argue for closing one, open an issue.
- **Security**: the current state is in [SECURITY.md](SECURITY.md) and the
  [threat model](docs/handbook/threat-model.md). What comes next for it is in
  [trust the gateway with my credentials](docs/intents/trust-the-gateway-with-my-credentials.md).

## Not planned

- **High availability.** One process and one embedded database is a design choice
  ([embedded store](docs/decisions/embedded-store-sqlite-and-migrations.md)); the code keeps a
  larger deployment possible but no work is scheduled for it.
- **Intercepting CLIs and SDKs.** Only MCP traffic, and git through the gateway's remote, pass
  through the gateway.
