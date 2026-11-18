# {{displayName}} — Vaubaan Gateway plugin

A plugin that teaches [Vaubaan Gateway](https://github.com/vaubaan/gateway) the service `{{id}}`:
its data model, its risk catalog, the MCP tools agents call, the classifier that sorts each call,
how an account connects, and the calls to the service.

## Quick start

`vaubaan-plugin init` made this project. It holds a complete plugin for an imaginary service
(widgets in workspaces) whose checks pass, to be replaced by the real service.

```bash
npm install
npm run check        # type check and the SDK's test kit: passes before any change
```

Then open your coding agent in this folder (Claude Code reads `CLAUDE.md`, other agents
`AGENTS.md`) and ask it to build the plugin for the real service, giving it the link to the
service's API documentation. It follows the skills in this order, each ending on a command that
says whether its step is done:

| Skill                   | What it does                                           | Stops for you            |
| ----------------------- | ------------------------------------------------------ | ------------------------ |
| `vaubaan-model-service` | Resource, entities, tools, from the service's API docs | to confirm the model     |
| `vaubaan-risk-catalog`  | Risks, vectors, macro-actions                          | on every write risk      |
| `vaubaan-classify`      | The classifier, its tests, one `npm run try` per tool  | when a call is unclear   |
| `vaubaan-credential`    | The token guide and the check at paste                 | on the credential choice |
| `vaubaan-execute`       | The calls to the service, against a mocked `fetch`     |                          |
| `vaubaan-ship`          | Build, sign, hand the archive to your gateway          | for the signing key      |
| `vaubaan-submit`        | Publish in the public catalog (optional)               | before publishing        |
| `vaubaan-upgrade`       | Move to a newer `@vaubaan/plugin-sdk`                  |                          |

## Try a call without a gateway

```bash
npm run try -- <tool> '<json args>' [--accept <risk id>,…] [--resources <ref>[:<env>],…]
```

prints the slices the classifier emits, the risks they touch and the decision against a sample
mission. Exit 0 when allowed, 1 when refused.

## Build, sign, ship

```bash
npm run build                                          # dist/plugin/ and dist/plugin.tgz
npx vaubaan-plugin keygen --out ~/.vaubaan/<company>-plugins   # once per company
npx vaubaan-plugin sign dist/plugin --key ~/.vaubaan/<company>-plugins.key.pem
```

Then, on your gateway, an administrator:

1. adds the public key (`.pub.pem`) once under Administration › Plugins › Trusted signers;
2. uploads `dist/plugin.tgz` under Administration › Plugins — or you do, from here, with the token
   of a mission an administrator issued on the gateway's Vaubaan account with "Install plugins":
   `VAUBAAN_MISSION_TOKEN=… npx vaubaan-plugin deploy --gateway https://<your gateway>`;
3. reads the permissions it adds and activates it; it starts on trial at the next start.

Keep the private key (`.key.pem`) out of every repository: `.gitignore` excludes `*.key.pem`.

To publish it in the public catalog instead, signed by Vaubaan and installable by every gateway:
push the project to a public GitHub repository, then `npx vaubaan-plugin submit --dry-run`, and
without `--dry-run` to open the pull request (skill `vaubaan-submit`).

## The plugin

To fill for the real service: the data model, the credential and what one resource is, the tools,
one line per risk, the macro-actions.
