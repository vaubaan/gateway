---
name: vaubaan-submit
description: Use when the human wants to publish the plugin in the public Vaubaan catalog, so any gateway can install it signed by Vaubaan. Prepares the public repository and the exact commit, writes the declaration and opens the pull request on vaubaan/gateway-plugins.
---

# Submit to the public catalog

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/submit (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

The catalog is the public repository `vaubaan/gateway-plugins`. It holds no plugin code: one
declaration per plugin, `catalog/<id>.yaml`, naming a public repository and an exact commit. A
pull request adding or changing a declaration is rebuilt from that commit without any secret and
reviewed; once merged, the catalog rebuilds the same commit, signs it (trust level "Vaubaan") and
publishes it as the release `<id>-v<version>`. Your own archive and your company key play no part.

## Inputs

- The public GitHub repository of the plugin (`https://github.com/<owner>/<repo>`), and the
  plugin's folder in it when it is not the root.
- The owners: the GitHub users or `org/team`s who may change the declaration later.
- The `gh` command line, logged in as the human (or their consent to open the pull request in the
  browser).

## Steps

1. **Stop for the human.** Confirm they want to publish: the source becomes public and reviewed by
   the catalog's maintainers, the id `<id>` (`SERVICE_ID` in `src/identity.ts`) becomes theirs in
   the catalog, and every gateway may install it. Check the id is free:
   `https://github.com/vaubaan/gateway-plugins/blob/main/catalog/<id>.yaml` must not exist (unless
   this is a new version of their own plugin).
2. **Make the source buildable by the catalog.** The catalog runs `npm ci --ignore-scripts` then
   `vaubaan-plugin build` on the declared commit:
   - `package-lock.json` is committed and in sync (`npm ci` passes locally);
   - no dependency needs an install script or a native addon;
   - `npm run check` and `npm run build` exit 0;
   - `package.json`'s `version` equals the `version` of `definePlugin`, and is the version you
     declare;
   - a `LICENSE` file at the plugin's root and a `license` field in `package.json`;
   - no private key, token or `.env` in the repository or its history.
3. **Publish the commit**: commit, push to the public repository, optionally tag it `v<version>`.
   Take the full sha: `git rev-parse HEAD` (40 hex characters). It must be reachable on GitHub.
4. **Check the declaration**: `npx vaubaan-plugin submit --dry-run [--owners <user>,<org>/<team>]`
   prints `catalog/<id>.yaml` for HEAD: id (`SERVICE_ID`), repo (from `origin`), path (the
   plugin's folder in the repository), version (`package.json`), commit, owners (the repository's
   owner unless `--owners`). It exits 1, saying why, on uncommitted changes, a commit not pushed,
   a remote outside GitHub, a missing `package-lock.json`, or a field the catalog would refuse.
5. **Open the pull request** once the human agrees: `npx vaubaan-plugin submit [--owners …]`. With
   `gh` logged in as the human, it forks `vaubaan/gateway-plugins`, commits the declaration on the
   branch `submit/<id>-<version>` and opens the pull request; it prints its URL. Then add to the
   pull request's description what the reviewer needs: what the service is, the resource, each
   tool with its slice, each write risk with its vector and why, the documentation the classifier
   was written from (`gh pr edit <url> --body-file <file>`).
6. **Optionally rebuild as the catalog will**, in a clone of the catalog:
   `bash scripts/build.sh <id> "$(mktemp -d)"`. It fetches the catalog's toolchain and your commit,
   installs, builds, and fails if the archive's id or version differs from the declaration.
7. **Read the check.** The `check` workflow validates every declaration, rebuilds what the pull
   request declares, and writes in its job summary what the reviewer reads: the declaration before
   and after, the permissions (risk ids) of the risk catalog, the files of the archive. A failure
   names its step: fix the plugin, push, update `commit`. The maintainers then review the risk
   catalog, the classifier and the execution code of the declared commit; a write classified as a
   read is a refusal.
8. After the merge: the release `<id>-v<version>` appears on the catalog, signed by Vaubaan, and
   gateways see it in their versions feed. A new version is a new pull request changing `version`
   and `commit`; only the owners named may change the declaration.

Done when: `gh pr checks <pull request number> --repo vaubaan/gateway-plugins --watch` exits 0.
