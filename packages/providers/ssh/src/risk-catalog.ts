/**
 * SSH — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/railway-ssh.md` §2.4.
 * Spec           : `docs/spec/gateway-risk-model.md` §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is
 * what the runtime imports (no YAML dep at runtime). Keep both in sync —
 * a CI lint in Phase 2 will diff the two structures.
 *
 * 4 risks + 1 fallback :
 *   - `ssh.exec-read`              — whitelisted reads
 *   - `ssh.exec-write`             — writes on any host (env-varied via
 *                                    `vector_overrides`)
 *   - `ssh.exec-read-secret-files` — co-touched on cat /etc/..., requires
 *                                    explicit acceptance
 *   - `ssh.uncategorized-write`    — catch-all fallback
 *
 * Conventions :
 *  - `acceptable_in_envs` is matched against the binding's `host_slug`
 *    (SSH's convention : one host = one env). The canonical host slugs
 *    are `staging-vps`, `dev-vps`, and `prod-vps`.
 *  - `ssh.exec-write` uses `vector_overrides` to express the per-env
 *    risk profile : the base `vector` is the non-prod profile ; the
 *    `prod-vps` override escalates reversibility, data, and cost axes.
 *    Cf. `docs/spec/risk-entry-per-env-vector.md` §1.
 *  - The classifier emits an EXTRA slice (identical, R-shaped) when the
 *    cmd matches a "cat /etc/...", "cat /root/...", "stat ~/.ssh/..."
 *    style heuristic — this is the explicit co-touch with
 *    `ssh.exec-read-secret-files`.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const sshRiskCatalog: RiskCatalog = {
  provider: 'ssh',
  risks: [
    // ─── Reads ─────────────────────────────────────────────────────────────
    {
      id: 'ssh.exec-read',
      label: 'Exécuter une commande shell read-only whitelist',
      reason:
        'Commandes en lecture seule reconnues par la whitelist regex (`journalctl`, ' +
        '`cat`, `ls`, `tail`, `head`, `grep`, `ps`, `docker ps/inspect/logs`, ' +
        '`systemctl status`, `df`, `free`, `uptime`, `ss -tlnp`, `md5sum`, `stat`). ' +
        'Pas de mutation.',
      matches: 'ssh.host[**].command.R',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'ssh.exec-read-secret-files',
      label: 'Lire un fichier potentiellement sensible (cat /etc/..., stat key)',
      reason:
        'La whitelist autorise `cat <path>` sans filtrer le path — donc ' +
        '`cat /etc/shadow`, `cat /root/.env`, `stat /home/<u>/.ssh/...` passent en R. ' +
        "Risque d'exfiltration des credentials hôte. Co-touché par le classifier en " +
        'plus de `ssh.exec-read` quand le cmd ressemble à un read sensible.',
      matches: 'ssh.host[**].command.R',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    // ─── Writes ────────────────────────────────────────────────────────────
    {
      id: 'ssh.exec-write',
      label: 'Exécuter une commande shell arbitraire',
      reason:
        'Toute commande hors-whitelist read → traitée W. Inclut sudo, install, rm, ' +
        'systemctl restart, docker run, etc. Sur un host non-prod (`staging-vps`, ' +
        '`dev-vps`) le risque est acceptable avec confirmation explicite du manager ' +
        '(reversal coûteux mais blast limité). Sur un host de production (`prod-vps`) ' +
        "la surface d'attaque est maximale : posture-shift potentiel, downtime " +
        'possible, coût non borné. Le vector_overrides prod-vps reflète cette escalation.',
      matches: 'ssh.host[**].command.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'posture',
      },
      vector_overrides: {
        'prod-vps': {
          reversibility: 'irreversible',
          data: 'secret',
          cost: 'unbounded',
        },
      },
      acceptable_in_envs: ['staging-vps', 'dev-vps', 'prod-vps'],
    },
    // ─── Fallback ──────────────────────────────────────────────────────────
    {
      id: 'ssh.uncategorized-write',
      label: 'Écriture SSH non catégorisée',
      reason:
        "Catch-all pour les writes qui n'ont pas été explicitement catégorisés " +
        '(toute slice W non couverte par exec-write). Sert de filet pour les futurs ' +
        'tools (ex. `ssh__sftp_put`) — en pratique jamais touché tant que `ssh__exec` ' +
        'est le seul tool exposé.',
      matches: 'ssh.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
