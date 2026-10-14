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

## 6. Backups

- **The volume**: use Railway's volume backups, or make a consistent copy
  while the gateway runs (`railway ssh` into the service, then a
  `VACUUM INTO` of `/data/gateway.db` — handbook
  [store](../docs/handbook/store.md#backup)) and download it.
- **The master key**, separately and outside Railway: a copy of the volume
  without it opens no stored credential, and the key without the volume is
  nothing. Losing the key loses every connection's credential.

## What the image does on Railway

Started as root (`RAILWAY_RUN_UID=0`), the entrypoint gives `/data` to the
user `vaubaan` (uid 10001) if anything there belongs to someone else, then
runs the server as that user with no capability; the security headers are set
by the gateway itself (deploy [README](README.md)), so Railway's edge needs no
configuration.
