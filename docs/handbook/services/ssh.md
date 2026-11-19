---
title: SSH plugin
tracks:
  - plugins/ssh/src/
  - plugins/ssh/README.md
last_reviewed: 2026-10-27
---

# SSH plugin — handbook

`@vaubaan/plugin-ssh`: one tool, `ssh__exec`, one shell line on one host per account; the host is
the resource and its owner label (`dev | staging | prod`) its environment.

## Start here

- [`src/shell-lex.ts`](../../../plugins/ssh/src/shell-lex.ts) — tokenises as `sh` / `bash` do.
- [`src/policy.ts`](../../../plugins/ssh/src/policy.ts) — the read allow-list, on whole argv.
- [`src/command/`](../../../plugins/ssh/src/command/) — one module per concern: wrappers
  (`wrappers.ts`), secret paths (`secret-paths.ts`), opaque commands (`opaque.ts`), class
  detectors (`classes.ts`) and `profileCommandLine` (`profile.ts`).
- [`src/transport.ts`](../../../plugins/ssh/src/transport.ts) — ssh2, the host-key pin, output caps.

## Invariants

- **Fail-closed rule**: a line is a read only when every simple command on it is recognised in full.
  What the classifier cannot see through is priced as the union of the classes (`secret-file.R`, `W`
  and the four markers `destructive`, `package`, `service`, `privilege`), never a plain `W`, never
  an empty list.
- The lexer models only quotes, escapes, comments, control operators, grouping, plain redirections,
  descriptor duplications, `$name`, `${name}`; everything else (substitution, ANSI-C quoting,
  here-documents, rich `${…}`, control characters, glued line continuations, odd `>&`) is opaque,
  not guessed. A differential fuzzer against `bash` found four desynchronisations, now pinned by
  tests; bare-flags are tracked per UTF-16 unit so a quoted emoji cannot hide a bare `*`.
- Opaque by command: a non-literal command word, inline code (`bash -c`, `python -c`, `find -exec`),
  indirect commands (`eval`, `source`, `ssh`, `awk`, `su`…), another host (`systemctl -H`,
  `docker -H`), container exec, unseen arguments for commands whose arguments decide their sight, an
  unlisted wrapper option (`sudo -i`, `env -S`), more than `MAX_WRAPPER_DEPTH` wrappers.
- **Reading the allow-list**: every argument must be a known option, its value or an operand of the
  expected shape; no prefix matching. Eligible only with a bare command name (`/bin/ls` is a write),
  no expansion, glob, brace, preceding assignment (`LD_PRELOAD=… ls`) or redirection to a file.
- `secret-file` is checked on every word and redirection target, per path segment, after collapsing
  `//` and `/./`, with words also cut on `=` `:` `,`. A path that cannot be seen (`..`, expansion,
  brace, a glob that could match a credential name) counts as a credential. Globs use the SDK's
  `matchWildcard`, never a regex (one backtracked for seconds and stalled the instance).
- `host` goes through one grammar, `hostRef`, in classify, execute and the credential: never an
  option (`-oProxyCommand=…`), never `.` / `..`. Refused, never escaped
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
- **The host key is pinned in the credential**: no trust on first use. The transport refuses a
  target without a well-formed `SHA256:` pin before any socket, and a mismatch ends the handshake
  before the key pair is offered. No path skips the verifier (`tests/unit/host-key-pinning.test.ts`
  runs the real transport against an in-process server).

## Traps

- The allow-list is a comfort zone, not a sandbox: the host-side login user and sudoers are the last
  word. Give a `developer` mission an account that cannot `sudo`.
- `./deploy.sh`, `make`, `git pull` are plain `W`: markers price what is written on the line. The
  opaque list is a deny-list of launchers and cannot be complete (`sed`'s `e`, a database client's
  shell escape, a `git` alias).
- **`exec-write` holds every class in practice.** A mission that may write can write a script and
  run it (`echo 'sudo rm -rf /srv' > /tmp/x; sh /tmp/x`), or copy `rm` under another name: the
  `sudo` and destructive markers see neither. They price what the line shows, they do not contain
  a writer. What contains it is the host account (no `sudo`, no write outside its directories)
  and the gate: on a host that matters, writes ask first. Accepted risk A47.
- Startup files and `PATH` are host-side: a function `ls` planted by an earlier write runs when a
  later mission calls `ls`.
- A non-zero exit is not `isError`. An unlabelled host (or a label outside the triad) never
  qualifies a write risk: missions on it can only read.

## Outside the repo

- The instance generates the ed25519 pair; the owner appends the public key to
  `~/.ssh/authorized_keys` of `user` and pastes the host key fingerprint, taken from a trusted
  machine: `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`.

## Debug

- `SshHostKeyMismatchError` → re-take the fingerprint from a trusted machine; a real change → the
  owner updates the account, otherwise an incident.
- `ssh authentication failed` → public key not in `authorized_keys`, or the account locked.
- A read lands in `W`, or a harmless line misses six risks → `profileCommandLine(cmd)` shows which
  class fired and `.opaque` why. Use literals, `printf '…' > file` instead of a here-document, a
  script file instead of `bash -c`.
- `exec-read-secret-files` on a line reading no secret → an expansion, `..` or glob in a path,
  `xargs`, recursive `grep` outside `/var/log`, or `docker inspect` (prints the container
  environment).
