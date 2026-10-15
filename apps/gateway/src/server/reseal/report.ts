/**
 * The text the `reseal` command prints: counts per table and what the operator
 * does next. Counts only — never an id, a key or a blob.
 */
import type { ResealReport, SealedVersionCount } from '../store';

export interface ResealSummary {
  readonly report: ResealReport;
  /** Blob counts per version after the run (unchanged by a dry run). */
  readonly remaining: readonly SealedVersionCount[];
  /** The versions of `VAUBAAN_MASTER_KEY_PREVIOUS`, ascending. */
  readonly previousKeyVersions: readonly number[];
}

export function renderReseal({ report, remaining, previousKeyVersions }: ResealSummary): string {
  const lines: string[] = [];
  const target = report.currentKeyVersion;
  lines.push(
    `reseal: current master key version ${target}; previous keys configured: ${
      previousKeyVersions.length > 0 ? previousKeyVersions.join(', ') : 'none'
    }.`,
  );
  lines.push(
    report.apply
      ? 'reseal: applied.'
      : 'reseal: dry run, nothing written (every blob below was opened). Pass --apply to write.',
  );
  const verb = report.apply ? 'resealed' : 'to reseal';
  const header = ['table', 'current', verb, 'unreadable', 'changed'];
  const rows = report.tables.map((t) => [
    t.table,
    String(t.current),
    String(t.resealed),
    String(t.unreadable),
    String(t.changed),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const format = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join('  ');
  lines.push(format(header));
  for (const row of rows) lines.push(format(row));

  const unreadable = sum(report.tables.map((t) => t.unreadable));
  const changed = sum(report.tables.map((t) => t.changed));
  if (unreadable > 0) {
    lines.push(
      `reseal: ${unreadable} blob(s) did not open: no key is configured for their version, or the key ` +
        'configured under that version is not the one that sealed them. They are left as they are. ' +
        'Add the missing key to VAUBAAN_MASTER_KEY_PREVIOUS and run again, or reconnect the accounts ' +
        'concerned (a new credential is sealed under the current key).',
    );
  }
  if (changed > 0) {
    lines.push(
      `reseal: ${changed} row(s) were rewritten by the running gateway during the run and were left ` +
        'as it wrote them. Run the command again.',
    );
  }

  const stale = remaining.filter((r) => r.keyVersion !== target && r.count > 0);
  const staleVersions = [...new Set(stale.map((r) => r.keyVersion))].sort((a, b) => a - b);
  if (!report.apply) {
    lines.push('reseal: run with --apply, then again without it to confirm.');
  } else if (staleVersions.length === 0) {
    lines.push(
      previousKeyVersions.length > 0
        ? `reseal: every blob is sealed under version ${target}. VAUBAAN_MASTER_KEY_PREVIOUS can now be ` +
            'removed from the configuration (then redeploy). Keep the old key out of every backup you keep.'
        : `reseal: every blob is sealed under version ${target}; no previous key is configured.`,
    );
  } else {
    lines.push(
      `reseal: blobs remain under version(s) ${staleVersions.join(', ')}: keep their key in ` +
        'VAUBAAN_MASTER_KEY_PREVIOUS until a run reports none.',
    );
  }
  return `${lines.join('\n')}\n`;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
