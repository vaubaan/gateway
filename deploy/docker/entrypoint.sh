#!/bin/sh
# Entrypoint of the gateway image (ADR railway-deployment-and-privilege-dropping-entrypoint).
#
# The image runs as the unprivileged user `vaubaan` (uid 10001). Some platforms
# mount the data volume owned by root and let a non-root process write nothing
# there; Railway's answer is to start the container as root (RAILWAY_RUN_UID=0).
# This script keeps the server non-root in both cases:
#
#   started as uid 0   give /data (and what is in it) to `vaubaan` when anything
#                      there belongs to someone else, then drop to `vaubaan`
#                      with setpriv (util-linux, part of the base image) — no
#                      capability kept, no new privilege possible — and exec
#                      the server;
#   started as anyone  exec the server as it is.
#
# The server is exec'd, never forked: it is PID 1's child or PID 1 itself, and
# receives the signals of the platform.
set -eu

APP_USER=vaubaan
DATA_DIR="${VAUBAAN_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  if [ -d "$DATA_DIR" ] && [ -n "$(find "$DATA_DIR" ! -user "$APP_USER" -print -quit)" ]; then
    echo "entrypoint: giving $DATA_DIR to $APP_USER (it was not owned by $APP_USER)" >&2
    # -h and -P: a symbolic link planted on the volume is given away itself, never
    # followed to what it points at (security audit 2026-10-31, L12).
    chown -R -h -P "$APP_USER:$APP_USER" "$DATA_DIR"
  fi
  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"
fi

exec "$@"
