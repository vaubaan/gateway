---
title: Every plugin, the default ones included, comes from one catalog that rebuilds it from source and signs it
status: accepted
date: 2026-11-17
---

# Every plugin, the default ones included, comes from one catalog that rebuilds it from source and signs it

## Context

Every plugin shipped inside the gateway image: a new or fixed plugin waited for a gateway release,
every instance carried every plugin, and a community author had to contribute to the gateway's own
repository. The image cannot hold every plugin forever, and a plugin runs in the process that holds
every credential, so what an instance loads must trace back to source someone reviewed.

## Decision

The catalog is one repository, `vaubaan/gateway-plugins`: one declaration per plugin (id, source
repository and path, version, commit, owners), added or changed by pull request; on merge its
workflow rebuilds the declared commit, signs the archive and publishes it with `versions.json`. No
plugin is preinstalled: an instance installs a catalog plugin when it first needs it
([plugins-installed-when-first-needed](./plugins-installed-when-first-needed.md)).

## Consequences

- A plugin entering or changing in the catalog changes no instance until one installs it.
- "Signed by Vaubaan" means built by the catalog workflow from a reviewed commit. A pull request's
  build runs without secrets and never signs.
- A plugin id belongs to the owners its declaration names (`CODEOWNERS`); a new version is a pull
  request changing the commit, reviewed on the diff from the previous one.
- The site's plugin pages and `versions.json` are built from the catalog, not from `plugins/`.

## Rejected alternatives

### Every plugin bundled in the gateway image

One release train for all plugins and an image that grows with the catalog; it survives only for
the two plugins that cannot be archives.

### Plugins submitted as pull requests to the gateway repository

Community code then lives and is maintained with the gateway, and an author works in its monorepo.

### A store portal with accounts and uploads

A service to operate (accounts, storage, moderation) for a volume a reviewed repository handles.

### Signing the archive the author built

The signature would vouch for a binary nobody read; rebuilding the declared commit ties it to the
source the review saw.
