---
title: Secret variables are deleted from the process environment once the configuration is loaded
status: accepted
date: 2026-10-13
extends:
  - docker-image-and-config-format
  - trust-model-clear-at-rest-idp-style
---

# Secret variables are deleted from the process environment once the configuration is loaded

## Context

The configuration reaches the process through environment variables (and an
optional YAML file that may reference variables). After `loadInstanceConfig()`
the values live in the typed `InstanceConfig`; nothing reads them from
`process.env` again. Yet `VAUBAAN_MASTER_KEY`, `VAUBAAN_MASTER_KEY_PREVIOUS`,
the sign-in and IdP client secrets, the provider apps' secrets and private keys
and `VAUBAAN_BOOTSTRAP_TOKEN` stayed in `process.env` for the life of the
process. Security review 2026-10-15 (secrets-and-infra H3, L1): any code that
dumps `process.env` (a debug route, an error reporter, a dependency), and any
child process a future feature starts, would carry the master key with it.

## Decision

1. The loader returns, beside the configuration, the list of the variables
   that carried a secret or the path of one (`LoadedConfig.secretEnvNames`):
   the secret keys of the key table (`kind: secret | secret-map`) and their
   `_FILE` siblings; `VAUBAAN_SIGN_IN_<ID>_CLIENT_SECRET[_FILE]`;
   `VAUBAAN_PROVIDER_<ID>_{CLIENT_SECRET,PRIVATE_KEY}[_FILE]`; and every
   variable the YAML file references with `${NAME}` **at a secret key**
   (`isSecretKeyPath`). One definition of "secret key" serves the loader, the
   error messages and this list.
2. `loadProcessConfig()` loads from `process.env` and deletes those variables
   from it. It is the default loader of the composition root and of the two
   operator commands (`import-v4`, `reseal`). Tests that inject their own
   environment are untouched.
3. Variables that are not secrets stay (`VAUBAAN_PUBLIC_URL`,
   `VAUBAAN_STORE_PATH`, `PORT`…): Next.js and the platform read some of them,
   and they hold nothing to protect.
4. The boot is fail-fast (`bootOrExit` exits on any error), so the deletion
   cannot leave a half-built process that would retry with an emptied
   environment.

## Consequences

- `process.env` holds no secret after boot; a child process inherits none.
- **What it does not do.** The kernel keeps the process's initial environment
  block: `/proc/<pid>/environ` (here `/proc/1/environ`, the server being PID 1
  or its direct child) still shows the values to the same user and to root,
  and so does a core dump. Anyone with a shell in the container
  (`railway ssh`, `docker exec`) reads them there, as they could read the platform's
  variables anyway. The threat model says so (A1).
- The secrets remain on the heap in `InstanceConfig` for the life of the
  process: that is how the gateway works (trust model "clear at rest,
  IdP-style"); only an unwrap service or a KMS would change it.
- A future feature that needs a secret in another process must pass it
  explicitly, never by inheritance.

## Rejected alternatives

- **A secret file on tmpfs unlinked after read.** Stronger (nothing in the
  environment at all), but Railway has no secret files; it stays possible with
  `*_FILE` on platforms that have them, and the variable naming the path is
  deleted too.
- **Overwrite the values instead of deleting the variables.** `process.env`
  assignments copy into a new environment string; neither form reaches the
  initial block the kernel exposes, and deletion is the simpler of the two.
- **Delete every `VAUBAAN_*` variable.** Some are read by the platform or the
  framework, or are useful in a diagnosis, and none of the remaining ones is a
  secret.
