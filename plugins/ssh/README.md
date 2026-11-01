# `@vaubaan/plugin-ssh`

Bash over SSH as a Vaubaan Gateway provider plugin on the plugin SDK
(`@vaubaan/plugin-sdk`). One tool, `ssh__exec`, runs a shell command line on a
host the connection reaches with its own ed25519 key pair and a **pinned host
key**. Inspection commands on a read allow-list are low-risk; everything else
is a write, and the classes that hurt (recursive deletes, package changes,
service control, sudo) carry their own risk so a trust level can gate them with
`approval`. A line the classifier cannot see through carries every class: the
classifier fails closed.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/ssh.md`](../../docs/handbook/providers/ssh.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Layout

| File                          | Role                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | `createSshPlugin({ transport })` → `definePlugin({...})`; default export `sshPlugin` over `ssh2`.                                                                      |
| `src/risk-catalog.yaml`       | 7 risks + fallback, three macro-actions. Loaded at boot by the SDK; the only catalog artefact.                                                                         |
| `src/data-model.ts`           | One plane `host`: `host` (the resource, env-scopable) → `command` → classification markers.                                                                            |
| `src/tools.ts`                | `ssh__exec` (`host?`, `cmd`, `timeout_s?`).                                                                                                                            |
| `src/shell-lex.ts`            | `lexCommandLine`: the line as a POSIX shell tokenises it (words, redirections, simple commands), and what it cannot model, by name; `splitCommandLine`, its text view. |
| `src/policy.ts`               | The read allow-list on whole argument vectors (`matchRead`, `isReadAllowed`) and the option parser it shares with the wrappers.                                        |
| `src/identity.ts`             | `PROVIDER_ID`, `TOOL_PREFIX`, `TOOL`: the provider id and tool names, written once.                                                                                    |
| `src/command/profile.ts`      | `profileCommandLine`: the classes of a whole line, one simple command at a time; the fail-closed rule.                                                                 |
| `src/command/secret-paths.ts` | Credential-bearing path detection (`looksLikeSecretFileRead`), per path segment, globs included.                                                                       |
| `src/command/wrappers.ts`     | Normalisation: keywords, assignments, wrappers unwrapped to the command that runs; `stripPrivilegePrefix`.                                                             |
| `src/command/opaque.ts`       | Commands that cannot be seen through (inline code, another user, host or container) and the tool families.                                                             |
| `src/command/classes.ts`      | The class detectors (destructive, package, service) and the worst case of unseen arguments.                                                                            |
| `src/classify.ts`             | `classifySsh(tool, args, resources)` — pure; host resolution against the mission's resources; `resolveExecArgs` shared.                                                |
| `src/credential.ts`           | `ssh-key` spec (host, port, user, host key fingerprint); `sshTarget()` narrows the secret; fingerprint helpers.                                                        |
| `src/transport.ts`            | `SshTransport` interface; `ssh2Transport` with host key verification, timeouts, output caps; the two host-key errors.                                                  |
| `src/execute.ts`              | `createSshRuntime({ transport })` → `execute`, `discoverResources`.                                                                                                    |

`src/index.ts` resolves the YAML path from `import.meta.url` as a **string**
(`SSH_CATALOG_PATH`), not with `new URL('./risk-catalog.yaml', import.meta.url)`:
Turbopack, which bundles the plugin into `apps/gateway`, rewrites that
pattern into an asset URL that Node's `fileURLToPath` rejects.

## Data model

```
host[<hostname | ip>]              the resource ; labelled dev / staging / prod by its owner
  └─ command                       one shell line : R per whitelisted simple command, W for any other
       ├─ secret-file              marker · a credential-bearing path is referenced, or a path cannot be seen
       ├─ destructive              marker · rm -r/-f, mkfs, dd, shred, reboot, userdel, iptables -F, docker prune…
       ├─ package                  marker · apt / dnf / apk / pacman / snap / brew… in a mutating mode, npm -g, pipx
       ├─ service                  marker · systemctl verbs, service, docker / compose lifecycle, pm2, kill…
       └─ privilege                marker · sudo / doas / pkexec on a non-whitelisted command
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

| Field                  | Required | Pattern                    | Purpose                                                                                                                                                                                        |
| ---------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                 | yes      | hostname or IPv4, ≤ 253    | The resource ref the agent cites (`host[vps-1.example.com]`). IPv6 literals are not accepted. One grammar (`hostRef`) for the credential, the resource ref, the `host` argument and the slice. |
| `port`                 | no       | 1–65535                    | 22 when empty.                                                                                                                                                                                 |
| `user`                 | yes      | POSIX user name            | The account whose `~/.ssh/authorized_keys` receives the public key.                                                                                                                            |
| `host_key_fingerprint` | yes      | `SHA256:<base64>` (`=` ok) | The host's key, verified on every connection; no trust-on-first-use.                                                                                                                           |

Setting up a host:

```sh
# 1. On the target, as the login user, append the public key the interface shows :
echo 'ssh-ed25519 AAAA… vaubaan-gateway' >> ~/.ssh/authorized_keys
# 2. From a machine that already trusts the host, read its ed25519 fingerprint :
ssh-keyscan -t ed25519 vps-1.example.com 2>/dev/null | ssh-keygen -lf -
#    256 SHA256:9kd…Qo vps-1.example.com (ED25519)   ← paste the SHA256:… value
```

There is no company-registered app for SSH: the key pair _is_ the app. The
private key is stored encrypted by the host and never leaves the instance. A
host that presents another key is refused with `SshHostKeyMismatchError`
during the key exchange, before the key pair is offered — if the host was
legitimately re-keyed, the owner updates the connection. A target without a
well-formed pin never opens a socket (`SshHostKeyNotPinnedError`); `sshTarget()`
refuses to build one in the first place. An authentication failure is an
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

The owner then labels it `dev`, `staging` or `prod` on the account's page (Accounts). **The label is
what qualifies the write risks** (`ssh[prod].exec-write`): the default
`resourceEnvResolver` reads it from the `host[<ref>]` segment of every slice,
so no plugin hook is needed. An unlabelled host cannot be written to through
a macro-action — label it. One credential is one host; a second host is a second
connection.

## Catalog and macro-actions

Risks (ids stable, never renamed): `exec-read`, `exec-read-secret-files`,
`exec-write`¹, `exec-destructive`¹, `exec-package-install`¹,
`exec-service-control`¹, `exec-sudo`¹, plus the fallback `uncategorized-write`.
¹ env-scoped: `acceptable_in_envs: [dev, staging, prod]`; `exec-write`,
`exec-destructive` and `exec-service-control` carry a `vector_overrides.prod`.

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous),
risk model §4.6; the trust level writes the explicit lines, one per labelled
environment the mission's hosts carry.

| Macro-action | What it covers                                 | Its risks                                                |
| ------------ | ---------------------------------------------- | -------------------------------------------------------- |
| `look`       | Read-only commands, credential files included. | `exec-read`, `exec-read-secret-files`                    |
| `fix`        | Write, restart and destroy.                    | `exec-write`, `exec-service-control`, `exec-destructive` |
| `install`    | Packages and sudo.                             | `exec-package-install`, `exec-sudo`                      |

Base budgets are in the YAML. The fallback is in no macro-action: the gateway
offers it under "Anything else".

## Classification rules

The classifier **fails closed**: a line is a read only when every simple
command on it is recognised in full, and whatever it cannot see through is
classified as the union of the classes, never as the mildest one.

1. `src/shell-lex.ts` tokenises the line the way `sh` / `bash` do: single and
   double quotes, backslash escapes, comments, `;` `&&` `||` `|` `&`, newlines
   and grouping parentheses, plain redirections, `$name` / `${name}`. Each
   simple command becomes a list of words with quotes removed.
2. A simple command is a **read** when its whole argument vector is on the
   allow-list (`src/policy.ts`): a bare command name, known options only,
   operands of the expected shape. No prefix matching:
   `journalctl --vacuum-time=1s`, `systemctl status -H host` and `/bin/ls`
   are not reads. A command is not eligible when it holds an expansion, a
   glob or a brace, a variable assignment, or a redirection to a file (`2>&1`
   and `< file` are fine). `sudo`, without options, is admitted on
   `journalctl`, on the `systemctl` inspection verbs and on `ss -tlnp`.
3. Anything else is a **write**. Before the detectors run, the command is
   normalised: the directory of the command word is dropped (`/bin/rm`,
   `./rm`), keywords and group tokens are stripped (`then`, `do`, `{`), and
   wrappers are unwrapped with their options (`env`, `command`, `exec`,
   `nohup`, `nice`, `time`, `timeout`, `stdbuf`, `setsid`, `xargs`, `sudo` /
   `doas` / `pkexec`). The detectors add `destructive`, `package` and
   `service`; a privilege wrapper adds `privilege`. When the arguments are not
   on the line (`rm $FLAGS`, `… | xargs rm`), the command gets the classes it
   could reach.
4. A credential-bearing path anywhere on the line adds `secret-file`: a path
   segment `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`; a file `.env*`,
   `id_rsa*`, `*.pem`, `*.key`, `shadow`, `passwd`, `sudoers`, `.netrc`…;
   `/root`, `/etc/ssl/private`, `/proc/…/environ`, a raw device under `/dev`.
   So does a path that cannot be seen: a `..` segment, an expansion, a brace, a
   glob that can match one of those names, a recursive `grep` outside
   `/var/log`, `docker inspect`, arguments fed by `xargs`.
5. A line is **opaque** — never a read, and carrying `secret-file` plus the
   four write markers — when it holds: a command or process substitution, a
   here-document, `$'…'` or `$"…"`, a control character, an unterminated
   quote, a backslash-newline glued to a token, a descriptor redirection other
   than `>&N` / `>&-`; a command word that is not a literal (`$CMD`, a glob);
   inline code or an indirect command (`bash -c`, `eval`, `python -c`, `awk`,
   `find -exec`, `watch`, `strace`…); another user, host or container (`su`,
   `ssh`, `docker exec` / `run`, `systemctl -H`, `docker -H`); a wrapper with an
   option the classifier does not know (`sudo -i`, `env -S`).
   `profileCommandLine(cmd).opaque` names the reason.
6. A mixed line (`ls; rm -rf old`) emits both sides; the mission needs every
   touched risk.

What it does not do: follow a script. `./deploy.sh`, `bash deploy.sh`, `make`
and `npm run build` are plain writes — running a program on the host is what
`exec-write` means, and the program may do anything its user can. The markers
price the commands written on the line, and the list of launchers in rule 5
is a deny-list that cannot be complete; the host-side boundary (the login
user, its sudoers entry) remains the last word. The allow-list, the wrappers
and the detectors are tables in `src/policy.ts` and `src/command/`;
widen them with a catalog review. The lexer assumes a POSIX shell on the host
(`sh`, `bash`, `dash`) and was checked against `bash` with a differential
fuzzer.

## Execution

`execute` re-validates the arguments with the function the classifier used,
refuses a `host` that is not the connection's host, clamps `timeout_s` to 300,
and runs the line through the transport. The result carries stdout, a
`[stderr]` block when any, and an `[exit N · T ms]` trailer; the same facts
are in `structuredContent`. A non-zero exit is a normal result, not an error.
Stdout is capped at 1 MiB (`truncated: true`), stderr at 4 KiB. The gateway's
`AbortSignal` destroys the connection.

## Tests

```
npx vitest run plugins/ssh
```

| Suite                      | Tests | What it pins                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin.test.ts`           | 303   | The SDK kit (`assertPluginWellFormed`, `assertNoWildcard`, `assertCatalogCoverage`), the classifier, **missions written from macro-actions at trust levels, evaluated through the policy engine** (what each allows, gates and refuses per host label), the lexer, the allow-list, the detectors, the credential spec, `execute` / `discoverResources` over a fake `SshTransport`. |
| `adversarial.test.ts`      | 181   | Command lines written to be read as milder than what the shell runs — quoting, comments, redirections, wrappers, interpreters, paths — each with its exact slices.                                                                                                                                                                                                                 |
| `classify.test.ts`         | 95    | One scenario per command line and the credential-path table.                                                                                                                                                                                                                                                                                                                       |
| `host-key-pinning.test.ts` | 37    | The real `ssh2Transport` against an in-process `ssh2.Server` on `127.0.0.1` (ephemeral port, closed after each test): a missing, malformed or mismatched pin is refused before authentication, proven from the server's side.                                                                                                                                                      |
| `injection.test.ts`        | 87    | `host` and `cmd` fed `..`, `a/../b`, encoded forms, empty, overlong and multi-line values, to `classify` and to `execute` over a recording transport: only a hostname or an IPv4 address names a host (argument or resource ref), a refused value opens no connection, and the line sent is the line classified.                                                                   |
| `data-model.test.ts`       | 2     | The data model's integrity and its markers.                                                                                                                                                                                                                                                                                                                                        |

No test reaches an external host or needs an `ssh` binary; only
`host-key-pinning.test.ts` opens a socket, on loopback.
