---
name: vaubaan-upgrade
description: Use when a gateway refuses the plugin for its SDK version, or to move the project to a newer @vaubaan/plugin-sdk. Reads the SDK's changelog, bumps the packages, fixes what the new version refuses, and rebuilds.
---

# Upgrade the SDK

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/sign-and-deploy#upgrade-the-sdk (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

An archive declares the SDK it was built against (`^<version>`). Before `1.0.0` a caret range
holds one minor version: a gateway on SDK 0.10 turns away a plugin built against 0.9 until it is
rebuilt. The fix is always on this side: upgrade, check, rebuild, upload again.

## Inputs

- The version to reach: the one the gateway's refusal names, or the latest
  (`npm view @vaubaan/plugin-sdk version`).
- The current one: `npm ls @vaubaan/plugin-sdk`.

## Steps

1. Read the changelog: https://github.com/vaubaan/gateway/blob/main/CHANGELOG.md (raw text at
   https://raw.githubusercontent.com/vaubaan/gateway/main/CHANGELOG.md). Take every `### Plugin
   SDK` section between the current version and the target, and list each line that concerns this
   plugin: a removed or renamed export, a member made required, a new rule of `definePlugin`, of
   the catalog loader or of the test kit.
2. Bump both packages together:

   ```bash
   npm install @vaubaan/plugin-sdk@<target>
   npm install --save-dev @vaubaan/plugin-cli@latest
   ```

   Commit the updated `package-lock.json` with the change.
3. Fix the type errors: `npx tsc --noEmit`. A name kept as a `@deprecated` alias still compiles:
   replace it with its new name now, aliases are removed in a later minor.
4. Fix what the new rules refuse: `npm run check`. `definePlugin` and the loader list every problem
   at once, each with its path; read them all. A rule that now refuses something is a fix to make
   in the plugin. Never loosen a test, a classifier branch or an assertion of the kit to pass.
5. If a fix makes a classification stricter, or a risk changes, follow the catalog's rules: bump
   `catalog_version`; never rename or delete a risk id (`deprecated: true`, `replaced_by`); prove the
   affected tools again with `npm run try` (skill `vaubaan-classify`, step 8).
6. Bump the plugin's version, in `package.json` and in `src/index.ts` (`definePlugin`), equal: a
   patch for an upgrade alone, a minor before 1.0 (a major after) for a stricter classification.
7. Rebuild and sign (skill `vaubaan-ship`, steps 3 to 7), and hand the new archive over. Tell the
   human an administrator activates the new version, on trial.

## Stop for the human

When a changelog line changes what a mission allows (a risk, a vector, a classification), show the
human the change before writing it, as `vaubaan-risk-catalog` does for a write risk.

Done when: `npm run check && npm run build` exits 0.
