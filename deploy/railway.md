# Vaubaan Gateway on Railway

The procedure lives on the site:
[Install on Railway](https://vaubaan.com/docs/install/railway)
([ADR](../docs/decisions/user-and-author-docs-live-on-the-site.md)).
Decisions: ADRs
[railway-deployment-and-privilege-dropping-entrypoint](../docs/decisions/railway-deployment-and-privilege-dropping-entrypoint.md)
and [github-sign-in](../docs/decisions/github-sign-in.md). Every key:
handbook [configuration](../docs/handbook/configuration.md).

## What the image does on Railway

Started as root (`RAILWAY_RUN_UID=0`, since Railway mounts volumes owned by
root), the entrypoint gives `/data` to the user `vaubaan` (uid 10001) if
anything there belongs to someone else, then runs the server as that user
with no capability (`deploy/docker/entrypoint.sh`; the smoke test runs both
starts). The server binds `0.0.0.0` and the `PORT` Railway sets. The security
headers are set by the gateway itself (deploy [README](README.md)), so
Railway's edge needs no configuration. A command run in `railway ssh` is
root: `vaubaan-entrypoint` drops it to the image user, and the backup,
restore, reseal and v4 import commands refuse root without it.

The gateway reads `RAILWAY_PROJECT_ID` and refuses that project to every
mission (its own variables hold the master key); `VAUBAAN_SELF_RESOURCES`
adds other resources of the hosting.

## Where each section went

Messages of the gateway and older notes cite the sections of this guide by
number; each now has its page on the site.

### 1. The service

[Install on Railway, 1. The service](https://vaubaan.com/docs/install/railway#1-the-service).

### 2. Variables

[Install on Railway, 2. Variables](https://vaubaan.com/docs/install/railway#2-variables), with the
verification of `VAUBAAN_CLIENT_IP_HEADER=x-real-ip` and the instance's own project.

### 3. The GitHub OAuth App

[Install on Railway, 3. The GitHub OAuth App](https://vaubaan.com/docs/install/railway#3-the-github-oauth-app).

### 4. The admin rule and who may sign in

[Install on Railway, 4. Who may sign in](https://vaubaan.com/docs/install/railway#4-who-may-sign-in).

### 5. Deploy a verified build

[Install on Railway, 5. Deploy a verified build](https://vaubaan.com/docs/install/railway#5-deploy-a-verified-build).

### 6. Backups

[Install on Railway, 6. Backups](https://vaubaan.com/docs/install/railway#6-backups), and
[backup and restore](https://vaubaan.com/docs/operations/backup-and-restore) for copying a backup
off the volume.

### 7. The git remote

[Install on Railway, 7. The git remote behind Railway's edge](https://vaubaan.com/docs/install/railway#7-the-git-remote-behind-railways-edge).

### 8. Rotating the master key

[Master key rotation, On Railway](https://vaubaan.com/docs/operations/master-key-rotation#on-railway).

### 9. Moving an instance

[Move an instance](https://vaubaan.com/docs/operations/move-an-instance).
