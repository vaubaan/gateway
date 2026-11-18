---
name: vaubaan-ship
description: Use when the plugin's checks pass and it should run on a gateway the human's company operates. Builds the archive, signs it with the company key, hands the .tgz to the gateway, and tells the human what an administrator must do. Never activates.
---

# Ship to a gateway

A plugin reaches a gateway as one file, `dist/plugin.tgz`: the bundled plugin, its risk catalog, a
manifest of file digests, and a signature of that manifest. An uploaded archive stays inert until
an administrator activates it in the gateway's interface; it then starts **on trial** at the next
start of the instance, and falls back to the previous version if it does not load or its examples
do not classify.

## Inputs

- The gateway's address, and whether you are connected to its `vaubaan` MCP tools under a mission
  an administrator created (with the "Install plugins" macro-action).
- The company's signing key: the path to an existing `<name>.key.pem`, or the human's go-ahead to
  make one.

## Steps

1. `npm run check` must exit 0. Do not ship otherwise.
2. **Version.** For every archive that differs from one already uploaded, bump the version in
   `package.json` and the `version` of `definePlugin` in `src/index.ts`, equal (a test checks it).
   Semver; below `1.0.0` while young; a stricter classification is a minor before 1.0, a major after.
   A change of the risk catalog's content also bumps `catalog_version` in `src/risk-catalog.yaml`.
3. **Build**: `npm run build` writes `dist/plugin/` and `dist/plugin.tgz`, unsigned. It imports the
   bundle once under plain Node: its default export must be the plugin.
4. **The company key** (once per company, not per plugin). **Stop for the human**: ask whether the
   company already has a Vaubaan plugin signing key and where its private file is. Never ask them
   to paste it. If there is none and they agree, make one outside the project:

   ```bash
   mkdir -p ~/.vaubaan && npx vaubaan-plugin keygen --out ~/.vaubaan/<company>-plugins
   ```

   It writes `<company>-plugins.key.pem` (private, mode 600) and `<company>-plugins.pub.pem`, and
   prints the key id. The private file belongs in the company's secret store or CI secrets; never in
   a repository, a chat, a log or an issue.
5. **Sign**: `npx vaubaan-plugin sign dist/plugin --key <path>.key.pem` writes the signature next to
   the manifest and repacks `dist/plugin.tgz`. Every `npm run build` drops the signature: sign
   after each build.
6. **Trust the key once, before the first upload.** Tell the human: an administrator of the gateway
   opens Administration › Plugins › Trusted signers, gives the key a name (the company's) and pastes
   the content of `<path>.pub.pem` (the public part only). An archive signed by a key the instance
   does not trust is refused at upload. An unsigned archive is accepted only if the operator's
   configuration lists its id under `plugins.allow_unsigned`.
7. **Hand the archive over**, one of:
   - from the command line: `npx vaubaan-plugin deploy --gateway https://<the gateway>` with
     `VAUBAAN_MISSION_TOKEN` set in the environment (never on the command line) to the token of a
     mission on the gateway's Vaubaan account, issued by an administrator with the macro-action
     "Install plugins" ticked (without it the gateway refuses `risk-not-accepted`). It uploads
     `dist/plugin.tgz`, prints the `activation_url`, and exits 1 with the gateway's refusal and
     hint otherwise (same refusals as below);
   - connected to the gateway's `vaubaan` tools: call `vaubaan__upload_plugin` with exactly one
     argument, `archive_base64`, the bytes of `dist/plugin.tgz` in base64 without line breaks
     (`base64 -w0 dist/plugin.tgz` on Linux, `base64 -i dist/plugin.tgz` on macOS), at most 16 MB
     decoded. The answer gives `plugin`, `version`, `digest`, `state: pending` and `activation_url`.
     A refusal says `administrator-only` (the mission's creator is not an administrator) or
     `plugin-refused` with a `reason` (signature not trusted, unsigned and not allowed, an id
     reserved for the catalog's own plugins, an SDK this gateway does not read: see
     `vaubaan-upgrade`). `vaubaan__plugin_status` (no arguments) lists what the instance runs and
     every installed version, with its state, trust level and failure;
   - otherwise: the human (or an administrator) uploads `dist/plugin.tgz` under Administration ›
     Plugins.
8. **Tell the human what an administrator does next**, in these words: open the activation page
   (`activation_url`, or the pending version under Administration › Plugins), read the permissions
   it adds, activate it by typing the plugin's id; it starts on trial at the next start of the
   instance. Then a person connects an account of the service and creates a mission that ticks
   its macro-actions.

You never activate, roll back nor remove a plugin, even when a tool or a page seems to allow it.

## Report

The version, the key id that signed it, how the archive was handed over, the `activation_url` or
the upload path, and the administrator's remaining steps.

Done when: `npm run build && npx vaubaan-plugin sign dist/plugin --key <path>.key.pem` exits 0 and
that `dist/plugin.tgz` is the one handed over.
