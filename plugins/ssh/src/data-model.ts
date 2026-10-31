/**
 * Data model of the `ssh` provider — plane `host`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/ssh.md.
 *
 * SSH stays the simplest provider of the gateway : one plane, one resource
 * (the host), one operation (a shell command). All the granularity lives in
 * the *content* of the command string, not in the structure of the host —
 * so the entities below `command` are **classification markers**, not things
 * that exist on the host : the classifier emits `command.destructive.W`
 * next to `command.W` when the line contains a recursive delete, so the
 * catalog can price that class apart and a trust level can gate it.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const sshDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'host',
      description:
        'One remote host reached over SSH with the key pair of the connection. The host is a black box : every operation is a shell command, and the security boundary on the host side (sudoers, file ACLs, the login user) still applies.',
      entities: [
        {
          name: 'host',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description:
            'The resource : the host of the connection, referenced by its hostname or IP (`host[vps-1.example.com]`). Labelled dev / staging / prod by its owner ; the label qualifies the write risks.',
        },
        {
          name: 'command',
          parent: 'host',
          cardinalities: ['one'],
          description:
            'One shell command line. `R` for each simple command on the read allow-list, `W` for any other ; a line the classifier cannot see through is `W` with every marker and never `R`. Always cardinality one at the call site.',
        },
        {
          name: 'secret-file',
          parent: 'command',
          cardinalities: ['one'],
          description:
            'Marker : the line references a credential-bearing path (`/etc/shadow`, `/root/…`, `.ssh/…`, `.aws/…`, `.env`, a private key, a raw device) or a path the classifier cannot see (an expansion, a parent segment, a recursive `grep`, `docker inspect`). Emitted as an extra `R` slice.',
        },
        {
          name: 'destructive',
          parent: 'command',
          cardinalities: ['one'],
          description:
            'Marker : recursive or forced delete, disk-level tool, reboot or shutdown, account deletion, firewall flush, journal vacuum, Docker prune.',
        },
        {
          name: 'package',
          parent: 'command',
          cardinalities: ['one'],
          description:
            'Marker : a system package manager in a mutating mode, or a global npm / pnpm / yarn / pipx install.',
        },
        {
          name: 'service',
          parent: 'command',
          cardinalities: ['one'],
          description:
            'Marker : service or process lifecycle — systemctl verbs, service, Docker / Compose lifecycle, pm2, supervisorctl, nginx -s, kill.',
        },
        {
          name: 'privilege',
          parent: 'command',
          cardinalities: ['one'],
          description:
            'Marker : the simple command runs through sudo, su, doas or pkexec and is not a whitelisted inspection verb.',
        },
      ],
    },
  ],
};
