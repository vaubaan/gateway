# `@vaubaan/plugin-ssh`

Bash over SSH as a Vaubaan Gateway provider plugin on the v5 SDK
(`@vaubaan/plugin-sdk`). One tool, `ssh__exec`, runs a shell command line on a
host the connection reaches with its own ed25519 key pair and a **pinned host
key**. Inspection commands on a read whitelist are low-risk; everything else
is a write, and the classes that hurt (recursive deletes, package changes,
service control, sudo) carry their own risk so a preset can gate them with
`approval`.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/ssh.md`](../../docs/handbook/providers/ssh.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Layout

| File                            | Role                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                  | `createSshPlugin({ transport })` → `definePlugin({...})`; default export `sshPlugin` over `ssh2`; `@deprecated` v4 exports.   |
| `src/risk-catalog.yaml`         | 7 risks + fallback, three presets, `catalog_version: 2`. Loaded at boot by the SDK; the only catalog artefact.                |
| `src/data-model.ts`             | One plane `host`: `host` (the resource, env-scopable) → `command` → classification markers.                                   |
| `src/tools.ts`                  | `ssh__exec` (`host?`, `cmd`, `timeout_s?`); legacy v4 declaration with `host_slug`.                                           |
| `src/policy.ts`                 | The read whitelist (`isReadAllowed`), unchanged since v4.                                                                     |
| `src/command-classes.ts`        | Quote-aware splitter, credential-path heuristic, destructive / package / service / privilege detectors, `profileCommandLine`. |
| `src/classify.ts`               | `classifySsh(tool, args, resources)` — pure; host resolution against the mission's resources; `resolveExecArgs` shared.       |
| `src/credential.ts`             | `ssh-key` spec (host, port, user, host key fingerprint); `sshTarget()` narrows the secret; fingerprint helpers.               |
| `src/transport.ts`              | `SshTransport` interface; `ssh2Transport` with host key verification, timeouts, output caps; `SshHostKeyMismatchError`.       |
| `src/execute.ts`                | `createSshRuntime({ transport })` → `execute`, `discoverResources`; legacy `sshExec`.                                         |
| `src/bash/{parse,args,exec}.ts` | Annotated-script parser, argument materialisation, invocation builder — moved from `apps/gateway/src/lib/bash` (P1.2i).       |
| `src/risk-classifier.ts`        | Legacy `classifySshV4` (`host_slug`, two identical R slices on a secret read). `// legacy v4, deleted in P1.6`.               |

`src/index.ts` resolves the YAML path from `import.meta.url` as a **string**
(`SSH_CATALOG_PATH`), not with `new URL('./risk-catalog.yaml', import.meta.url)`:
Turbopack, which bundles the plugin into the v4 `apps/gateway`, rewrites that
pattern into an asset URL that Node's `fileURLToPath` rejects.

## Data model

```
host[<hostname | ip>]              the resource ; labelled dev / staging / prod by its owner
  └─ command                       one shell line : R (every simple command whitelisted) or W
       ├─ secret-file              marker · a credential-bearing path is referenced
       ├─ destructive              marker · rm -r/-f, mkfs, dd, shred, reboot, userdel, iptables -F, docker prune…
       ├─ package                  marker · apt / dnf / apk / pacman / snap / brew… in a mutating mode, npm -g, pipx
       ├─ service                  marker · systemctl verbs, service, docker / compose lifecycle, pm2, kill…
       └─ privilege                marker · sudo / su / doas / pkexec on a non-whitelisted command
```

The markers are not things that exist on the host; they let the catalog price
a class of command apart. A `sudo apt-get install -y nginx` on host `H` emits
`host[H].command.W`, `host[H].command.package.W` and
`host[H].command.privilege.W`, which touch `exec-write`,
`exec-package-install` and `exec-sudo` — the mission must have accepted the
three.

## Credential

Kind `ssh-key`, algorithm ed25519. The host generates the key pair, shows the
public key, and collects four non-secret fields:

| Field                  | Required | Pattern                    | Purpose                                                                                       |
| ---------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `host`                 | yes      | hostname or IPv4           | The resource ref the agent cites (`host[vps-1.example.com]`). IPv6 literals are not accepted. |
| `port`                 | no       | 1–65535                    | 22 when empty.                                                                                |
| `user`                 | yes      | POSIX user name            | The account whose `~/.ssh/authorized_keys` receives the public key.                           |
| `host_key_fingerprint` | yes      | `SHA256:<base64>` (`=` ok) | The host's key, verified on every connection; no trust-on-first-use.                          |

Setting up a host:

```sh
# 1. On the target, as the login user, append the public key the UI shows :
echo 'ssh-ed25519 AAAA… vaubaan-gateway' >> ~/.ssh/authorized_keys
# 2. From a machine that already trusts the host, read its ed25519 fingerprint :
ssh-keyscan -t ed25519 vps-1.example.com 2>/dev/null | ssh-keygen -lf -
#    256 SHA256:9kd…Qo vps-1.example.com (ED25519)   ← paste the SHA256:… value
```

There is no company-registered app for SSH: the key pair _is_ the app. The
private key is stored encrypted by the host (v4 kept it as a plain bytea) and
never leaves the instance. A host that presents another key is refused with
`SshHostKeyMismatchError` before authentication — if the host was legitimately
re-keyed, the owner updates the connection. An authentication failure is an
`UpstreamAuthError`: the host marks the connection `expired` and the owner
reconnects (a new key pair).

## Resources

`discoverResources` connects once — which verifies the pinned host key and the
key pair — runs `uname -n -s -r -m`, and returns the host as the connection's
single resource:

```ts
{ provider: 'ssh', ref: 'vps-1.example.com', displayName: 'deploy@vps-1.example.com:22',
  metadata: { user: 'deploy', port: 22, host_key_fingerprint: 'SHA256:…',
              hostname: 'vps-1', kernel: 'Linux 6.8.0-45-generic', machine: 'x86_64' } }
```

The owner then labels it `dev`, `staging` or `prod` in the UI. **The label is
what qualifies the write risks** (`ssh[prod].exec-write`): the default
`resourceEnvResolver` reads it from the `host[<ref>]` segment of every slice,
so no plugin hook is needed. An unlabelled host cannot be written to through
a preset — label it. One credential is one host; a second host is a second
connection.

## Catalog and presets

Risks (ids stable, never renamed): `exec-read`, `exec-read-secret-files`,
`exec-write`¹, `exec-destructive`¹, `exec-package-install`¹,
`exec-service-control`¹, `exec-sudo`¹, plus the fallback `uncategorized-write`.
¹ env-scoped: `acceptable_in_envs: [dev, staging, prod]`; `exec-write`,
`exec-destructive` and `exec-service-control` carry a `vector_overrides.prod`.

| Preset      | Intent                                                                                                        | Approval-gated by default                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `read-only` | Inspect: logs, processes, disk, services, files outside credential paths.                                     | —                                                                                                                     |
| `developer` | One token per code project: reads, file and process writes on `dev` and `staging`, service restarts on `dev`. | `ssh[staging].exec-service-control`. No prod, no packages, no destructive, no sudo, no credential files.              |
| `operator`  | Everything on every labelled host.                                                                            | Credential-file reads; every `prod` entry; destructive, package, service and sudo on `staging` (all `auto` on `dev`). |

Budgets are per period; see the YAML for the numbers. Presets are UI sugar;
the persisted mission policy is always the explicit enumeration. No preset
references the fallback.

## Classification rules

1. The line is split into simple commands on `;`, `&&`, `||`, `|`, `&` and
   newlines, honouring quotes and backslash escapes.
2. A simple command on the read whitelist (`src/policy.ts`) is a read; the
   whitelist admits `sudo` only on `journalctl`, `systemctl status`-like verbs
   and `ss -tlnp`.
3. Anything else is a write. After stripping `sudo [options]` / `doas` /
   `pkexec`, the detectors add the `destructive`, `package` and `service`
   markers; the prefix itself adds `privilege` (`su` too).
4. A credential-bearing path anywhere on a simple command
   (`/etc/shadow|sudoers|passwd|gshadow`, `/root/…`, `~/.ssh|.aws|.gnupg|.kube|.docker/…`,
   `/home/<u>/.ssh/…`) adds `secret-file`.
5. A command substitution (`$(…)`, backticks, `<(…)`), an output redirection
   to a file (`>`, `>>`, `&>`; `2>&1` is fine) or an unterminated quote makes
   the whole line a write, whatever the visible commands.
6. A mixed line (`ls; rm -rf old`) emits both sides; the mission needs every
   touched risk.

The detectors are heuristics that err towards flagging; the host-side
boundary (the login user, its sudoers entry) remains the last word. The
whitelist and the detectors are tables in `src/policy.ts` and
`src/command-classes.ts`; widen them with a catalog review.

## Execution

`execute` re-validates the arguments with the function the classifier used,
refuses a `host` that is not the connection's host, clamps `timeout_s` to 300,
and runs the line through the transport. The result carries stdout, a
`[stderr]` block when any, and an `[exit N · T ms]` trailer; the same facts
are in `structuredContent`. A non-zero exit is a normal result, not an error.
Stdout is capped at 1 MiB (`truncated: true`), stderr at 4 KiB. The gateway's
`AbortSignal` destroys the connection.

### Annotated scripts

The v4 "bash provider" let an owner attach an annotated script
(`# @vaubaan: ring=… action=…`) to a binding and exposed one tool per
function. The parser, argument materialisation and invocation builder moved
here (`src/bash/`) with their tests, but no tool uses them yet: an
owner-curated script is per-connection configuration the v5 connection model
does not carry, and a script supplied by the agent could not be trusted for
its `action=read` annotation. Re-wiring it is a question for the connections
feature (P1.4); until then `ssh__exec` is the whole surface.

## Tests

```
npx vitest run plugins/ssh
```

`tests/unit/plugin.test.ts` runs the SDK kit (`assertPluginWellFormed`,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage`), the v5
classifier, the splitter and the class detectors, the credential spec and the
fingerprint pin, and `execute` / `discoverResources` over a fake
`SshTransport` injected through `createSshPlugin({ transport })`.
`bash-{parse,args,exec}.test.ts` are the moved parser suites, unchanged.
`risk-classifier.test.ts` (39 v4 cases) and `data-model.test.ts` are kept
until P1.6. No test opens a socket.

## Removed from v4

- `risk-catalog.ts` (TypeScript twin) and `risk-catalog.test.ts` (its lint):
  the YAML is the only catalog artefact, in the v5 shape (`provider:` instead
  of the legacy top-level `ssh:`).
- `acceptable_in_envs` as host slugs (`staging-vps`, `prod-vps`): the
  environment is the owner's label on the resource.
- The duplicated-slice "co-touch" on a credential-file read: `exec-read` and
  `exec-read-secret-files` now match different slices, so a `read-only`
  mission can read logs without being granted the credential-file risk.
- Unpinned host keys: v4 accepted whatever key the host presented.
