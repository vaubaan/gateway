# Deploying Vaubaan Gateway on Railway

One Railway service built from this repository's Dockerfile, one volume, the
configuration in Railway variables, sign-in through GitHub. Decisions: ADRs
[railway-deployment-and-privilege-dropping-entrypoint](../docs/decisions/railway-deployment-and-privilege-dropping-entrypoint.md)
and [github-sign-in](../docs/decisions/github-sign-in.md). Every key:
handbook [configuration](../docs/handbook/configuration.md).

What Railway's documentation says, as read for this guide (through Context7,
2026-10-14) — check it again before relying on it:

- volumes are mounted owned by root, and an image that runs as another user
  should set `RAILWAY_RUN_UID=0` (Volumes → Permissions); one volume per
  service, and a service with a volume is redeployed with a short downtime;
- `RAILWAY_DOCKERFILE_PATH` names a Dockerfile that is not at the root;
- the edge terminates TLS and forwards `X-Real-IP` (the client's address),
  `X-Forwarded-Proto` (always `https`) and `X-Forwarded-Host`;
  `X-Forwarded-For` is not in that list, and no source address range of the
  edge is published (Networking → Public networking → Specs and limits);
- a service binds `0.0.0.0` and the port in `PORT`;
- `railway up` uploads the current directory and builds it; automatic
  deployments from a connected branch can be disabled.

## 1. The service

1. Create a project and an empty service (do not connect a repository, or
   connect it and **disable automatic deployments**: you deploy a verified
   build, step 5).
2. Add **one volume** to the service, mounted at `/data`.
3. Generate a domain (or attach your own). Its `https://` origin is your
   public URL.

## 2. Variables

| Variable                                 | Value                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `RAILWAY_DOCKERFILE_PATH`                | `deploy/docker/Dockerfile`                                              |
| `RAILWAY_RUN_UID`                        | `0` — the entrypoint gives `/data` to the gateway's user and drops root |
| `VAUBAAN_PUBLIC_URL`                     | `https://<your domain>`                                                 |
| `VAUBAAN_STORE_PATH`                     | `/data/gateway.db`                                                      |
| `VAUBAAN_MASTER_KEY`                     | `npm run gen-master-key`; keep a copy outside Railway (step 6)          |
| `VAUBAAN_ADMIN_EMAILS`                   | your address, as GitHub has it as your primary verified email           |
| `VAUBAAN_SIGN_IN_GITHUB_KIND`            | `github`                                                                |
| `VAUBAAN_SIGN_IN_GITHUB_CLIENT_ID`       | from step 3                                                             |
| `VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET`   | from step 3                                                             |
| `VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY` | `true` (or `VAUBAAN_SIGN_IN_GITHUB_ALLOWED_EMAIL_DOMAINS`)              |

`PORT` is set by Railway and honoured by the server; do not set it. With a
sign-in provider in the configuration no bootstrap token is needed; set
`VAUBAAN_BOOTSTRAP_TOKEN` (32 characters or more) only if you prefer to add
providers from the interface.

**`VAUBAAN_TRUSTED_PROXIES`: leave it unset.** The gateway believes a client
address only from `X-Forwarded-For` written by a declared proxy. Railway
documents `X-Real-IP` instead and publishes no address range for its edge, so
there is nothing safe to declare: confidence that Railway's edge can be
declared is low until a deployment shows what reaches the process. Unset, the
per-address limits are one window shared by everybody and the audit records
no client address; the gateway says so in one warning at boot (accepted risk
A2 of the [threat model](../docs/handbook/threat-model.md)). Never set
`0.0.0.0/0`: any client could then choose the address it is limited and
audited under.

**The instance's own project is never a mission resource.** Railway sets
`RAILWAY_PROJECT_ID` in the container; the gateway reads it and refuses that
project to every mission — not offered when a mission is created, refused at
call time even if an older mission selected it, and tagged "this instance's
own project: never reachable by a mission" on the account page. Without this,
a Railway account connected to the gateway lists the project the gateway runs
in, and a mission with `railway.read-variables` on it would read
`VAUBAAN_MASTER_KEY` (security review 2026-10-15, H1). The refusal covers the
project as a mission resource; it does not cover what the Railway credential
reaches by other means (`railway.agent-action` hands Railway's own agent a
free-text request). On an account that can see the gateway's own project,
Railway's agent (`railway__railway-agent`) is therefore unavailable — refused
at call time, left out of the tool list, and said on the account page — and
every other tool stays bound to the mission's projects. Still prefer **a separate Railway workspace** for the
gateway, and never connect that workspace's token to the gateway itself. To
protect another resource of the hosting (a backup bucket, a second service),
list it in `VAUBAAN_SELF_RESOURCES` (`<provider>:<ref>`, comma-separated).

**`VAUBAAN_CLIENT_IP_HEADER=x-real-ip`: only after you verified it.** The
trusted-edge mode reads the client address from `X-Real-IP` alone (ADR
[client-address-from-a-trusted-edge-header](../docs/decisions/client-address-from-a-trusted-edge-header.md)).
It is safe only if Railway's edge **overwrites** that header on every request;
if the edge passes a client's value through, any client picks the address it
is limited and audited under. It is off by default. To verify on your
instance, once:

1. Set `VAUBAAN_CLIENT_IP_HEADER=x-real-ip`, deploy, and sign in.
2. Make one tool call through `/mcp` with a mission key **and** the header
   `X-Real-IP: 192.0.2.1` added by hand (for instance with `curl`, a
   `tools/call` of any read tool of the mission).
3. Open Activity on that entry: its client address must be your real public
   address. If it reads `192.0.2.1`, the edge passes the header through:
   unset the variable at once and redeploy.

## 3. The GitHub OAuth App

At GitHub, under the settings of your organisation (or of your account) →
Developer settings → OAuth Apps → New OAuth App:

- **Homepage URL**: your public URL;
- **Authorization callback URL**: `https://<your domain>/auth/callback/github`
  (the id of the provider, `github`, ends the address);
- leave device flow off. Generate a **client secret**; copy the client id and
  the secret into the variables of step 2.

The gateway asks for `read:user user:email`, and `read:org` only when
`VAUBAAN_ADMIN_GROUP` names a team (`github:<org>/<team>`). If your
organisation restricts OAuth App access, approve the App there before you use
a team rule.

This OAuth App only signs people in. The **GitHub App** through which
missions reach your repositories is another one, and you do not make it by
hand: once signed in, open Settings → Administration → Company apps →
GitHub, choose your organisation (for the dogfooding instance, `vaubaan`),
keep the name `Vaubaan <your domain>` or change it, review the permissions
(Contents write, Administration and Workflows are sensitive: withhold what
your missions do not need, especially on private repositories of a free plan,
which have no branch protection), and press "Create the GitHub App" then
"Continue to GitHub". GitHub asks you to confirm and sends you back; the App
belongs to your organisation and its key stays in this gateway, encrypted.
Then "Install it on your repositories". Do not set
`VAUBAAN_PROVIDER_GITHUB_*`: an App set in the variables is read-only on that
page and cannot be created there.

## 4. The admin rule and who may sign in

GitHub is open to anyone: the gateway refuses to start with a GitHub provider
that has neither allowed domains nor invitation only. With invitation only,
the addresses of `VAUBAAN_ADMIN_EMAILS` are admitted and are administrators;
everybody else needs an invitation (Settings → People → Invite). A person is
admitted on the **primary, verified** address of their GitHub account only.

## 5. Deploy a verified build

Deploy the commit that passed the checks, not whatever was pushed last:

```bash
git checkout <the verified commit>
npm ci && npm run ci && npm run test:e2e
npm run docker:build && npm run docker:smoke
git archive --format=tar HEAD | (rm -rf /tmp/vaubaan-release && mkdir /tmp/vaubaan-release && tar -x -C /tmp/vaubaan-release)
cd /tmp/vaubaan-release && railway link && railway up --ci
```

`railway up` uploads the clean tree of that commit (no `node_modules`, no
local `.env`) and Railway builds it with the Dockerfile. Then open
`https://<your domain>/healthz` (it answers the version and the commit) and
sign in.

Never run `railway up` from your working copy: it uploads the directory you
are in. The repository's `.railwayignore` keeps `.env*`, keys (`*.pem`,
`*.key`, `id_*`), `.mcp.json`, `deploy/config/gateway.yaml`, `.vaubaan/`,
`.claude/` and the other agent directories out of that upload as a safety net
(`.dockerignore` does the same for the image), but a file it does not name
would still leave your machine; the clean archive above is the procedure.

## 6. Backups

- **The volume**: use Railway's volume backups, or make a consistent copy
  while the gateway runs, with the command the image ships:

  ```bash
  railway ssh
  vaubaan-entrypoint node /app/apps/gateway/backup.mjs
  # backup: /data/backup-2026-10-16T08-00-00-000Z.sqlite
  # backup: 1234567 bytes, schema version 15, integrity_check: ok
  # backup: its secrets are sealed under master key version(s) 1: …
  ```

  It copies `/data/gateway.db` with SQLite's `VACUUM INTO` next to it, never
  overwrites a file, refuses root (`vaubaan-entrypoint` drops to the image
  user) and checks the copy (handbook [store](../docs/handbook/store.md#backup)).
  Copy it off the volume, for instance from your machine:
  `railway ssh -- base64 /data/<file> > backup.b64 && base64 -d backup.b64 > backup.sqlite`
  (check this once on your setup: the copy must open with `sqlite3` and pass
  `PRAGMA integrity_check`), then delete it from the volume
  (`railway ssh -- rm /data/<file>`).

- **The master key**, separately and outside Railway: a copy of the volume
  without it opens no stored credential, and the key without the volume is
  nothing. Losing the key loses every connection's credential. **A copy opens
  only with the keys of the versions it names** (the third line above), as
  they were when it was made: keep those keys with it. After a rotation
  (§8) the copies taken before need the old key.

## 7. The git remote

Agents clone and push through `https://<your domain>/git/<owner>/<repo>.git`.
Railway's edge limits (docs.railway.com, "Public networking — specs and
limits", read on 2026-10-14): a request may last up to 15 minutes while data
flows and is closed after 5 minutes without any; **a request body must finish
uploading within 5 minutes**; headers are capped at 32 KB; no body size limit
is stated. The defaults fit: `VAUBAAN_GIT_MAX_PACK_MB=200` (about 5.5 Mbit/s
of upload to send 200 MiB in 5 minutes) and `VAUBAAN_GIT_REQUEST_TIMEOUT=10m`
(under the 15 minutes). A push larger than the agent's link can send in 5
minutes fails at Railway's edge: push fewer commits at a time.

## 8. Rotating the master key

After any suspicion that the key was seen (a transcript, a screen share, a
workspace member who left), rotate it **and reseal**: a rotation alone leaves
every stored credential openable by the old key. Handbook
[configuration](../docs/handbook/configuration.md#rotating-the-master-key),
ADR [master-key-rotation-reseals-every-blob](../docs/decisions/master-key-rotation-reseals-every-blob.md).
Every command below runs in a `railway ssh` session on the service that serves
the store — never from another image or from your machine (a newer image would
migrate the file). `railway ssh` is root: `vaubaan-entrypoint` drops to the
image user. If a command answers "this instance is not configured" (exit 78),
the session lacks the service variables: open it again with `railway ssh` on
the right service and environment.

0. **Back up first**, while the current key is the only one:
   `vaubaan-entrypoint node /app/apps/gateway/backup.mjs` (§6). Copy the file
   off the volume and keep it **with the current key**: it opens with that key
   only.
1. On a trusted machine, `npm run gen-master-key`. Edit the **three**
   variables of the service together: `VAUBAAN_MASTER_KEY` = the new key,
   `VAUBAAN_MASTER_KEY_VERSION` = the current version plus one (it is `1`
   when unset), `VAUBAAN_MASTER_KEY_PREVIOUS` = `<old version>=<old key>`.
2. Deploy **once**, with the three staged changes applied together (never one
   by one: a deploy with the new key and the old version opens nothing).
   Check `/healthz`, and the log of the boot: a line "stored secrets do not
   open with the configured master keys" means a variable is wrong — fix it
   and deploy again before anything else.
3. Dry run, apply, confirm:

   ```bash
   vaubaan-entrypoint node /app/apps/gateway/reseal.mjs           # dry run: every blob opened
   vaubaan-entrypoint node /app/apps/gateway/reseal.mjs --apply
   vaubaan-entrypoint node /app/apps/gateway/reseal.mjs           # "nothing to reseal: …"
   ```

   The dry run opens every blob, the current ones too: a non-zero
   `current unreadable` column means `VAUBAAN_MASTER_KEY` is not the key that
   sealed them — stop, do not pass `--apply`. Exit 1 with a non-zero
   `changed` column is normal on a busy instance (the gateway refreshed a
   token meanwhile): run `--apply` again.

4. When the confirming run says **"nothing to reseal: every blob is sealed
   under version N … VAUBAAN_MASTER_KEY_PREVIOUS can now be removed"**, delete
   `VAUBAAN_MASTER_KEY_PREVIOUS` and deploy again.
5. Replace the copy of the key you keep outside Railway (§6) with the key **as
   Railway holds it** (copy it from the service's variables, not from the
   terminal where you generated it), so a paste error at step 1 cannot leave
   your offline copy useless. Backups taken before step 3 — yours from step 0
   and Railway's own volume backups, if they are on — open only with the old
   key: keep it with them, or delete them.

## 9. Moving an instance

To another Railway service, to a Fly machine, to a server of your own: the new
instance starts from this one's store, and nobody drops a file on its volume
by hand. ADR
[restore-verifies-before-it-replaces-and-runs-at-first-boot](../docs/decisions/restore-verifies-before-it-replaces-and-runs-at-first-boot.md),
handbook [store](../docs/handbook/store.md#restore).

1. **Back up the source** (§6) and note the copy's hash in the same session:

   ```bash
   vaubaan-entrypoint node /app/apps/gateway/backup.mjs move.sqlite
   sha256sum /data/move.sqlite
   ```

   Copy the file off the volume (§6) and check the hash on your machine
   (`sha256sum move.sqlite`). Note the master-key versions the backup named:
   the new instance needs those keys.

2. **Stop the source from changing**: what it writes after the backup —
   audit entries, and above all a provider token it refreshes (a provider that
   rotates refresh tokens invalidates the one in the copy) — is not in the copy.
   Take the backup as late as you can, and stop the source (remove its domain,
   or its deployment) as soon as the file is off the volume.
3. **Put the copy where the new host can fetch it**: an object storage bucket
   and a presigned GET URL that expires within the hour (S3:
   `aws s3 presign s3://<bucket>/move.sqlite --expires-in 3600`). The URL is a
   credential to the whole store (whose secrets the master key still
   protects): give it only as a secret of the new service. A self-hosted target
   can use a file path instead (a volume mounted read-only beside `/data`).
4. **Configure the new instance** with the source's variables (the same
   `VAUBAAN_PUBLIC_URL` if the domain moves with it, the same sign-in providers
   and company apps) and:
   - a **new master key** (`npm run gen-master-key`) in `VAUBAAN_MASTER_KEY`,
     `VAUBAAN_MASTER_KEY_VERSION` = the source's version plus one, and
     `VAUBAAN_MASTER_KEY_PREVIOUS` = `<source version>=<source key>` (every
     version the backup named);
   - `VAUBAAN_RESTORE_FROM` = the presigned URL (or the path), as a secret
     (Fly: `fly secrets set`), and `VAUBAAN_RESTORE_SHA256` = the hash.
5. **Deploy it, with an empty volume.** Before it opens the store the server
   downloads the copy, checks the hash, SQLite's integrity check, that its
   schema is not newer than the image, and that its keys open every stored
   secret, then puts it in place and migrates it. The boot log says
   `store restored` (bytes, hash, schema version, key versions; never the URL).
   A refusal stops the boot with the reason and writes nothing: fix the
   variable and deploy again. A restart after a successful restore only logs a
   warning. The first boot lasts as long as the download: the health check may
   fail meanwhile.
6. **Reseal on the new instance** (§8 step 3): dry run, `--apply`, confirming
   run. Once it says `VAUBAAN_MASTER_KEY_PREVIOUS can now be removed`, remove
   it **and** `VAUBAAN_RESTORE_FROM` and `VAUBAAN_RESTORE_SHA256`, and deploy.
   Delete the copy from the bucket.
7. **Point the domain at the new instance.** If the public URL changes, update
   the callback of every company app (`<public_url>/connections/callback/<provider>`,
   the sign-in callbacks) and the addresses the agents use (MCP, the remote of
   their repositories). Keep the source's volume until the new instance has run
   for a while, then delete it; the source's key opens only the backups taken
   before the move: keep it with them, or delete them.

The same restore runs as a command, with the gateway stopped since it replaces
the store: `node apps/gateway/restore.mjs <file or https URL> --sha256 <hex>`
(`--dry-run` to check a copy first, `--force` to replace a store that exists;
the old one is kept as `<name>.replaced-<time>`).

## What the image does on Railway

Started as root (`RAILWAY_RUN_UID=0`), the entrypoint gives `/data` to the
user `vaubaan` (uid 10001) if anything there belongs to someone else, then
runs the server as that user with no capability; the security headers are set
by the gateway itself (deploy [README](README.md)), so Railway's edge needs no
configuration.
