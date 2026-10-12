/**
 * SSH provider data-model — plane `host`.
 *
 * Spec : docs/spec/gateway-risk-model.md §2 + .vaubaan/research/providers/
 * railway-ssh.md §2.
 *
 * SSH is intentionally the simplest provider in the gateway : one plane
 * (`host`), one entity below the host (`command`). A host is a black box
 * registered as an `ssh_binding` (host_slug → SSH key + address). Every
 * tool call is a `command` executed on that host ; the read/write nature
 * is decided by a regex whitelist (`policy.ts:isReadAllowed`) on the
 * command string.
 *
 * Note : there is *no* containment hierarchy below `command`. All
 * granularity (which files are touched, which package is installed, etc.)
 * lives inside the *content* of the command string, not in the structure.
 * The risk catalog uses that fact : a `cat /etc/...` command is detected
 * by the classifier via heuristics on the cmd string and emits an extra
 * slice that co-touches the `ssh.exec-read-secret-files` risk.
 *
 * The data-model is consumed by :
 *  - the handbook : auto-rendered as mermaid for the SSH provider page.
 *  - lint coverage : every tool MCP must classify to a slice rooted at a
 *    declared entity. With a single tool (`ssh__exec`) and a single entity
 *    (`command`) the coverage matrix is trivial.
 */

import type { DataModel } from '@vaubaan/shared';

export const sshDataModel: DataModel = {
  provider: 'ssh',
  planes: [
    {
      slug: 'host',
      description:
        'One registered remote host (one SSH binding = one host = one env). All operations are shell commands executed via `ssh__exec`. The host is a black box from the gateway perspective; security boundaries live host-side (sudoers, file ACLs).',
      entities: [
        {
          name: 'host',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description:
            'A registered SSH endpoint identified by `host_slug`. One host per binding; the slug carries the env semantics (e.g. `staging-vps`, `prod-host`).',
        },
        {
          name: 'command',
          parent: 'host',
          cardinalities: ['one'],
          description:
            'A single shell command invocation. R or W is decided by the read-whitelist regex; the gateway does not parse the shell AST. Always cardinality `one` at the call site.',
        },
      ],
    },
  ],
};
