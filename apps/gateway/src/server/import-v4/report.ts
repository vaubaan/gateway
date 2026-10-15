/**
 * The importer's report as the operator reads it on stderr: what was (or,
 * in a dry run, would be) created, what is left to do by hand, and why each
 * v4 permission that did not carry over was dropped. Plain text, one fact
 * per line. Never a secret: the report holds ids, refs, names and risk ids
 * only, and the CLI blanks the bundle's secrets out of it once more.
 */
import type {
  ConnectionStatus,
  ImportReport,
  LabelStatus,
  MissionOutcome,
  MissionStatus,
} from './importer';
import { withoutControlCharacters } from './control-characters';
import type { DropReason } from './risk-translation';

const CONNECTION_WORDS: Record<ConnectionStatus, string> = {
  'to-create': 'to create (checked at the service at --apply)',
  created: 'created',
  'already-imported': 'already imported by an earlier run',
  'already-connected': 'already connected by hand with the same settings: kept',
  failed: 'refused, nothing stored',
  'provider-not-shipped': 'not imported: this instance ships no plugin for it',
  'revoked-in-v4': 'not imported: revoked in v4',
};

const LABEL_WORDS: Record<LabelStatus, string> = {
  'to-label': 'to label',
  labelled: 'labelled',
  'already-labelled': 'already labelled',
  'label-set-by-plugin': 'label set by the service, kept',
  'kept-owner-label': 'already labelled otherwise by its owner, kept',
  'not-a-v5-label': 'left unlabelled: the v4 label is not prod, staging, preview or dev',
  'conflicting-labels': 'left unlabelled: v4 projects gave it different labels',
  'not-owned': 'left as is: the account is shared with the owner, not theirs',
};

const MISSION_WORDS: Record<MissionStatus, string> = {
  'would-issue': 'would be issued',
  issued: 'issued',
  exists: 'already exists (its key was printed by the run that issued it)',
  'after-connections': 'issued at --apply once the connections above are created',
  deferred: 'deferred: run the import again once this is done',
  'nothing-to-issue': 'not issued: no v4 permission carries over',
  refused: 'refused by the issuance check',
};

const DROP_WORDS: Record<DropReason, string> = {
  'denied-in-v4': 'denied in v4 (a v4 denial trumps acceptance)',
  'unknown-in-v5': 'unknown to the v5 catalog',
  'deprecated-in-v5': 'deprecated in the v5 catalog',
  'no-exact-env-counterpart':
    'environment-qualified in v4 with no exact v5 counterpart (never widened)',
  'env-unresolvable': 'needs a resource labelled with one of its environments',
  'no-preset-budget': 'no preset of the plugin gives it a budget: add it by hand',
  'outside-authority': "outside the owner's authority on the account",
};

export function renderReport(report: ImportReport): string {
  const lines: string[] = [];
  const mode = report.apply ? 'APPLY' : 'DRY RUN (nothing written; add --apply to write)';
  lines.push(`Import of v4 organization '${report.org}' for ${report.owner} — ${mode}`, '');

  lines.push('Accounts imported from v4:');
  if (report.connections.length === 0) lines.push('  (none)');
  for (const c of report.connections) {
    const id = c.connectionId ? ` [${c.connectionId}]` : '';
    const detail = c.detail ? ` — ${c.detail}` : '';
    lines.push(`  - ${c.provider} "${c.displayName}": ${CONNECTION_WORDS[c.status]}${id}${detail}`);
  }
  lines.push('');

  lines.push('Accounts to connect by hand (their v4 secret is not imported):');
  if (report.byHand.length === 0) lines.push('  (none)');
  for (const b of report.byHand) {
    const state =
      b.status === 'connected'
        ? 'already connected on this instance'
        : b.status === 'to-connect'
          ? 'TO CONNECT in Accounts'
          : b.status === 'revoked-in-v4'
            ? 'revoked in v4: skipped'
            : 'no plugin on this instance: skipped';
    lines.push(`  - ${b.provider}: ${state} (${b.reason})`);
  }
  lines.push('');

  if (report.resources.length > 0) {
    lines.push('Environment labels of resources:');
    for (const r of report.resources) {
      const env = r.env ? ` → ${r.env}` : '';
      lines.push(
        `  - ${r.provider} ${r.ref}: ${LABEL_WORDS[r.status]}${env} (v4: ${r.v4Labels.join(', ')})`,
      );
    }
    lines.push('');
  }

  if (report.unmatched.length > 0) {
    lines.push(
      'v4 resources found on no account of the owner (connect the account, or refresh its discovery):',
    );
    for (const u of report.unmatched) lines.push(`  - ${u.provider} ${u.ref}`);
    lines.push('');
  }

  lines.push('Missions:');
  if (report.missions.length === 0) lines.push('  (no active, reusable, unexpired v4 token)');
  for (const m of report.missions) lines.push(...missionLines(m));
  lines.push('');

  const s = report.skipped;
  const skipped = [
    s.project_env_vars > 0 ? `${s.project_env_vars} project variable(s) (no v5 counterpart)` : null,
    s.child_tokens > 0 ? `${s.child_tokens} delegated token(s) (no sub-mission in v5)` : null,
    s.bash_bindings > 0 ? `${s.bash_bindings} bash binding(s) (no bash provider in v5)` : null,
    s.ssh_hosts_not_exported.length > 0
      ? `SSH hosts not asked with --ssh-host: ${s.ssh_hosts_not_exported.join(', ')}`
      : null,
  ].filter((line): line is string => line !== null);
  if (skipped.length > 0) {
    lines.push('Not imported:');
    for (const line of skipped) lines.push(`  - ${line}`);
    lines.push('');
  }

  if (report.keys.length > 0) {
    lines.push(
      `${report.keys.length} mission key(s) printed on stdout, once: install each now, they are not stored anywhere else.`,
    );
  }
  lines.push(report.failed ? 'Finished with refusals: see above.' : 'Finished.');
  // Names and refs come from the v4 database: a newline or an escape sequence in
  // one must not forge a line of the report the operator reads before --apply.
  return `${lines.map(withoutControlCharacters).join('\n')}\n`;
}

function missionLines(m: MissionOutcome): string[] {
  const lines = [
    `  - "${m.name}" (v4 token ${m.tokenName}): ${MISSION_WORDS[m.status]}${m.missionId ? ` [${m.missionId}]` : ''}`,
  ];
  if (m.previous) lines.push(`      ! ${previousLine(m.previous)}`);
  for (const c of m.connections) {
    lines.push(
      `      ${c.provider} [${c.connectionId}] on ${c.refs.join(', ')}: ${c.riskIds.length} risk(s)`,
    );
  }
  for (const reason of m.reasons) lines.push(`      ! ${reason}`);
  for (const e of m.expanded) {
    lines.push(
      `      ~ ${e.v4RiskId} → ${e.v5RiskIds.join(', ')} (one per environment of the selected resources)`,
    );
  }
  for (const c of m.carried) {
    const from = c.v4RiskId === c.v5RiskId ? '' : ` (v4: ${c.v4RiskId})`;
    lines.push(`      ~ carried under approval: ${c.v5RiskId}${from}`);
  }
  for (const d of m.dropped) {
    const ids = d.v5RiskIds.length > 0 ? ` [${d.v5RiskIds.join(', ')}]` : '';
    lines.push(`      - dropped ${d.v4RiskId}: ${DROP_WORDS[d.reason]}${ids}`);
  }
  if (m.unbound.length > 0) {
    lines.push(
      `      - dropped (the project has no resource on their service): ${m.unbound.join(', ')}`,
    );
  }
  return lines;
}

/** `--reissue`: the earlier import of the same v4 token, which the importer never revokes. */
function previousLine(previous: NonNullable<MissionOutcome['previous']>): string {
  return previous.status === 'active'
    ? `previous import ${previous.missionId} still active: revoke it once the new key is installed`
    : `previous import ${previous.missionId} is ${previous.status}`;
}
