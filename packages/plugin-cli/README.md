# @vaubaan/plugin-cli

The command line of a [Vaubaan Gateway](https://github.com/vaubaan/gateway) plugin author:
start a plugin project, try a call without a gateway, build and sign the archive, hand it to a
gateway, submit it to the public catalog.

```bash
npx @vaubaan/plugin-cli init acme-crm --id acme-crm --name "Acme CRM"
cd acme-crm && npm install && npm run check
```

The new project is a complete plugin for an imaginary service, its tests passing, with the
instructions and skills a coding agent follows to replace it by the real service (`AGENTS.md`,
`.claude/skills`, `.agents/skills`).

| Command                                                  | What it does                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `vaubaan-plugin init <dir> --id <id> [--name <name>]`    | A new plugin project                                                              |
| `vaubaan-plugin try <tool> ['<json args>'] [--accept …]` | One call: its slices, the risks it touches, the decision (exit 0 only if allowed) |
| `vaubaan-plugin build`                                   | `dist/plugin/` and `dist/plugin.tgz`, the archive a gateway installs              |
| `vaubaan-plugin keygen --out <path>`                     | A company signing key, once per company                                           |
| `vaubaan-plugin sign dist/plugin --key <path>.key.pem`   | Signs the archive                                                                 |
| `vaubaan-plugin deploy --gateway <url>`                  | Uploads the archive, pending (token in `VAUBAAN_MISSION_TOKEN`); never activates  |
| `vaubaan-plugin submit [--owners …] [--dry-run]`         | The pull request that proposes the plugin to the public catalog                   |

Specification: [plugin authoring](https://github.com/vaubaan/gateway/blob/main/docs/spec/plugin-authoring.md).

## License

Apache-2.0.
