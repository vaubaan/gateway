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
- The plugin versions an instance reads come from the catalog (amendment below), not from the
  site. The site's plugin pages are still built from `plugins/`; building them from the catalog is
  the proposed intent
  [Read each service's page from the catalog](../intents/believe-what-the-site-says.md#read-each-services-page-from-the-catalog).

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

## Amendment 2026-11-19: the catalog publishes its own index

### Context

The site's `versions.json` and the gateway's `catalog-versions.json` were written by hand in the
gateway's repository for each plugin version: a commit and a site deployment per release of any
plugin, against this record's aim that both come from the catalog.

### Decision

After each release, the catalog's workflow publishes `index.json` on the catalog repository's
GitHub Pages: per plugin, its service's name (from its declaration), its latest version and the
sha256 of its archive. An instance reads it beside the versions feed and takes the plugins'
versions from it; the feed keeps the gateway's version and the advisories. A gateway release
copies the index of that day into `catalog-versions.json` (`npm run release:prepare`), its
fallback when the index cannot be read. A plugin version is the catalog's pull request alone.

### Consequences

- The index is not trusted: an archive is kept only if the catalog's signature verifies and it
  is the id and version asked for; the sha256 only lets an instance refuse a different download
  early.
- A declaration names its service (`name:`), shown in the connect picker before installation.
- Gateways released before read plugin versions from `versions.json`, whose plugin entries no
  longer move.

### Rejected alternatives

#### The site rebuilds `versions.json` from the catalog

A site deployment per plugin release, and the site's host between the catalog and every
instance.
