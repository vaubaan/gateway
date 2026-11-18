# {{displayName}} — a Vaubaan Gateway plugin

This project is a plugin for [Vaubaan Gateway](https://github.com/vaubaan/gateway), an MCP gateway:
coding agents work under a **mission** (a set of resources and the risks its creator accepted)
instead of holding the service's credentials. The plugin teaches the gateway one service, `{{id}}`:
what it contains, which calls are dangerous, how to sort each call, how to connect, how to call it.

You work in this project only. You never need the gateway's source, never edit it, never open a
pull request on `vaubaan/gateway`.

The project starts as a complete plugin for an imaginary service (widgets in workspaces). Its checks
pass. The skills below replace the imaginary service with the real one, file by file.

## Words

- **Resource**: one thing an account reaches and a mission can be limited to (a project, a zone).
  Its owner labels it with an environment (`staging`, `prod`).
- **Slice**: what one call touches, a path on the data model ending in `R` or `W`:
  `{{id}}.workspace[ws-1].widget[w-7].W`. The classifier emits it.
- **Risk**: a named reason a call may be dangerous (`{{id}}.widget-write`), with the slice patterns
  it covers. People see it as a "permission".
- **Macro-action**: a group of risks a mission creator ticks at a trust level (Careful, Trusting,
  Autonomous).

## Files

| File                          | What it holds                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `src/identity.ts`             | `SERVICE_ID`, the tool names (`TOOL`), the credential field name. The only place ids are written. |
| `src/data-model.ts`           | The entities a slice can name, with containment and cardinalities.                      |
| `src/risk-catalog.yaml`       | The risks, their patterns and vectors, the fallback entry, the macro-actions.          |
| `src/tools.ts`                | The MCP tools: description, JSON input schema, a short title each.                     |
| `src/classify.ts`             | `(tool, args, resources) → slices`. Pure, fails closed. The security-critical file.    |
| `src/examples.ts`             | At least one realistic sample call per tool; the tests and `npm run try` run them.     |
| `src/credential.ts`           | How an account connects: the token page, the guide, `verify`.                          |
| `src/execute.ts`              | The calls to the service through `httpJson`, and `discoverResources`.                  |
| `src/icon.ts`                 | The service's mark (one 24×24 SVG path) and its colour.                                |
| `src/index.ts`                | `definePlugin({...})`, the default export.                                             |
| `tests/unit/*.test.ts`        | The SDK's test kit and your cases. No test calls a real service.                       |

## Skills, in order

Each skill is in `.claude/skills/<name>/SKILL.md` (and `.agents/skills/`). Each ends on a command
whose exit code 0 means its step is done. Do not start a skill before the previous one is done.

1. `vaubaan-model-service` — read the service's API docs; choose the resource, the entities, the tools.
2. `vaubaan-risk-catalog` — the risks and macro-actions. **Stops for a human on each write risk.**
3. `vaubaan-classify` — the classifier, its tests, the examples; each tool tried with `npm run try`.
4. `vaubaan-credential` — the credential guide and `verify`. **Stops for a human on the credential choice.**
5. `vaubaan-execute` — the calls to the service, resource discovery, tests against `mockFetch`.
6. `vaubaan-ship` — build, sign with the company key, hand the archive to a gateway.
7. `vaubaan-submit` — submit the plugin to the public catalog (optional).
8. `vaubaan-upgrade` — move to a newer `@vaubaan/plugin-sdk` (when a gateway asks for it).

## Hard rules

- **The classifier is pure**: no network, no clock, no credential, no file. Same input, same output.
- **The classifier fails closed**: an unknown tool, a missing or malformed argument, a resource
  outside the mission, an ambiguous resource → `{ denied: '<sentence>' }`. Never a broader slice
  "to be safe", never a default value.
- **A write is never classified as a read.** A call that changes anything, sends anything, or hands
  out a credential or a signed URL is a write. When the docs do not say, ask the human.
- **What is classified is what is sent**: `execute` reads identifiers with the classifier's own
  functions; a value outside its grammar is refused, never escaped or repaired.
- **Stop and ask the human** before writing each write risk (its vector, its environments, its
  macro-action) and before choosing the credential (kind of token, scope, expiry). Show your
  proposal, wait for an explicit answer, write what they decided.
- **Never activate a plugin.** An administrator activates it in the gateway's interface. You may
  upload an archive; you never activate, roll back nor remove one.
- **Never commit, print or paste a private key** (`*.key.pem`) or a service token. `.gitignore`
  excludes `*.key.pem`; keep the company key outside the project.
- Read the service's documentation from its source, never from memory. Name the pages you used in
  a comment of the file that relies on them.
- `src/` imports `@vaubaan/plugin-sdk` (and libraries you add to `dependencies`); never
  `process.env`, never `fetch` outside the SDK's transport.
- Write the service id and tool names only in `src/identity.ts`; everything else imports
  `SERVICE_ID` and `TOOL`.
- Never weaken a test or an assertion of the kit to make it pass. Fix the plugin.

## Commands

```bash
npm run check                          # tsc --noEmit, then vitest run: the kit's assertions
npm run try -- <tool> '<json args>' [--accept <risk id>,…] [--resources <ref>[:<env>],…] [--trust careful|trusting|autonomous]
                                       # one call: its slices, the risks it touches, the decision
                                       # exit 0 allowed, 1 refused or denied, 2 usage error
npm run build                          # dist/plugin/ and dist/plugin.tgz (unsigned)
npx vaubaan-plugin keygen --out <path> # once per company: <path>.key.pem, <path>.pub.pem
npx vaubaan-plugin sign dist/plugin --key <path>.key.pem   # signs, repacks dist/plugin.tgz
VAUBAAN_SIGNING_KEY=<path>.key.pem npm run sign            # the same, the path from the environment (CI)
```

Without `--accept`, `npm run try` accepts every macro-action at the trust level (Careful by default),
never "Anything else": a call that lands on the fallback is refused, which is how you spot a tool
the catalog does not cover. Pass `--accept` to prove exactly which risks a call needs.

## Where to read more

- The contract: `node_modules/@vaubaan/plugin-sdk/README.md` and the types of `ServicePlugin`.
- The SDK's changes: the "Plugin SDK" sections of
  https://github.com/vaubaan/gateway/blob/main/CHANGELOG.md
