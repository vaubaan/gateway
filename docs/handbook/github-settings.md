---
title: GitHub settings — the repositories' protections and security, as code, and what stays manual
tracks:
  - .github/settings/
  - scripts/github-settings.sh
last_reviewed: 2026-11-20
---

# GitHub settings

The protections of the project's two repositories live on GitHub, outside git: losing the
organisation, moving it or recreating a repository loses them silently. They are written here,
in [`.github/settings/`](../../.github/settings/), one folder per repository, and
[`scripts/github-settings.sh`](../../scripts/github-settings.sh) checks or reapplies them.

- `vaubaan/gateway`: this repository. The gateway's code, its releases (tags `v*`), the OAuth
  broker's (`oauth-broker-v*`) and the plugin kit's (`npm-plugin-*`).
- `vaubaan/gateway-plugins`: the plugin catalog. Every commit on its `main` signs and publishes
  plugins (its `release.yml`), so its `main` is the most sensitive branch of the project.

## Checking and reapplying

```sh
gh auth login                          # as an administrator of the repositories
scripts/github-settings.sh check       # what differs; exits 1 on a difference
scripts/github-settings.sh apply       # GitHub made to match the files
scripts/github-settings.sh check gateway-plugins   # one repository
```

A setting changed in the GitHub interface is changed in the files in the same breath, then
`check` says nothing. Most settings are not readable anonymously: `check` needs the
administrator's `gh`, not a token of the CI.

## What the files hold

| Repository      | File                        | What it guarantees                                                                                                                                                                                                              |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gateway         | `ruleset-release-tags.json` | Tags `v*`, `oauth-broker-v*`, `npm-plugin-*`: created, moved or deleted by a repository administrator only. A write token cannot publish a release.                                                                             |
| gateway         | `main-protection.json`      | `main`: no force-push, no deletion, linear history; no pull request required (maintainers push to `main`, see the [workflow](../workflow/coding-workflow.md)).                                                                  |
| gateway-plugins | `ruleset-main.json`         | `main`: through a pull request (0 approvals, a single maintainer) whose job `check` is green; no force-push, no deletion. Administrators bypass.                                                                                |
| both            | `repository.json`           | Merged branches deleted; no wiki.                                                                                                                                                                                               |
| both            | `security.json`             | Private vulnerability reporting (the only channel [`SECURITY.md`](../../SECURITY.md) gives), Dependabot alerts, secret scanning with push protection, a fork's pull request runs workflows only after a maintainer approves it. |

In a ruleset, `bypass_actors` actor `5` of type `RepositoryRole` is the role "Repository
admin"; `integration_id` 15368 is GitHub Actions, the app that reports the check `check`.

## What stays manual

GitHub has no API for these, or they belong to another service. After a reinstall, do them by
hand:

- **Two-factor authentication required** for every member of the organisation `vaubaan`:
  organisation settings, _Authentication security_. Every protection above falls with a
  maintainer's password otherwise.
- **npm trusted publishing** of `@vaubaan/plugin-sdk` and `@vaubaan/plugin-cli`, on npmjs.com:
  procedure in the [workflow](../workflow/coding-workflow.md), plugin kit section.
- **Discussions**: off today; a checkbox in the repository's settings, _Features_.
- **OpenSSF Scorecard**: nothing to set, `scorecard.yml` publishes; the README badge reads it.

## Traps

- The releases are tagged with the maintainer's own account, through the gateway or not: it is
  a repository administrator, so the tag ruleset lets it through. A tag pushed by another
  account is refused at the push, before any workflow starts.
- `apply` on a ruleset is a replacement (`PUT`): a rule added in the interface and not in the
  file disappears.
- Deleting a ruleset in the interface and running `apply` recreates it with another id; nothing
  refers to the id.
