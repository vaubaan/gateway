---
title: Vaubaan Gateway spec §5 — Composition
status: draft
---

# Vaubaan Gateway spec — §5 Composition

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §5").

## 5. Composition

- **[gateway-risk-model](./gateway-risk-model.md)** — plugins, risk catalogs, slices, scope caps,
  `risk-not-accepted`, the speed mechanism. This spec adds the cumulative quota and the mission log.
  Stateless scope caps are not enforced: shipped risk catalogs declare none
  ([scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md)). Where that
  document says binding, project policy or project-scoped root token, read: resource of an
  account, share restriction, mission.
- **Plugins** — one per service: classify `(tool, arguments) → slices` and execute with an
  ephemeral credential. Each declares its one way of connecting (a pasted key with its form, check
  and guide; a key pair the instance generates; or the service's sign-in), how to withdraw the grant
  on revocation (or where a person removes it), how to discover resources and which tools create
  one, and its macro-actions. Contribution: [CONTRIBUTING](../../CONTRIBUTING.md),
  [plugins/README](../../plugins/README.md). Writing one:
  [plugin-authoring](./plugin-authoring.md). Every published plugin comes from one public
  **catalog**: a declaration per plugin naming its source and exact revision, added by a reviewed
  change; the catalog rebuilds each declared revision itself and signs the archive, so "signed by
  Vaubaan" means built by the catalog from reviewed source
  ([ADR](../decisions/plugin-catalog-rebuilt-from-source.md)). The image carries no service
  plugin: only the management plugin and a plugin that cannot be archived (`ssh`) are compiled
  into the server, and a catalog plugin is installed when a person first connects its service
  ([ADR](../decisions/plugins-installed-when-first-needed.md)). A **private** plugin is built
  outside the catalog and signed with its author's own key, which an instance trusts by naming it
  a signer; its existence is published nowhere. A plugin reaches an instance installed when a person first
  connects its service, installed by an administrator (uploaded, or from the catalog in one click), or
  pinned by the operator in the plugins directory, the pin winning over the others of its id
  ([ADR](../decisions/plugins-bundled-or-pinned-by-the-operator.md)). It runs in the process with
  the credential, so it runs only signed by Vaubaan when a person first connects its service, once an administrator
  activated it, or once the operator placed it, and its archive is checked against its signature at every start; a signature says who built the
  plugin, never that it is harmless
  ([ADR](../decisions/plugins-activated-by-an-administrator-on-trial.md),
  [ADR](../decisions/plugin-signature-sets-the-trust-level.md)).
- **Sign-in providers** — authenticate humans with subject, verified email and, for a directory,
  groups. Trusted for their own issuer's identities only, never for authorization.
- **Push services and messaging services** — reached outbound, without an account: a push service
  relays a sealed envelope it cannot read to the person's device; a messaging service receives what
  the person's address accepts. The instance holds the subscription or the address, nothing more.
- **Services** — the connect flow runs between user, service and instance, no third party. A
  mailbox plugin may sign in with an app password; nothing is ever sent by mail.
- **Community collector** — receives consenting instances' reports, publishes aggregates (§9).
- **MCP clients** — any; the gateway knows the mission, not the client.
