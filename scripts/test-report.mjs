/**
 * The weekly test report (ci.yml, job `coverage`): what the tests cover, per area, and the
 * slowest test files, as Markdown for the run's summary. Information only: no threshold
 * fails a run (docs/quality/code-quality.md, docs/tests/integration-tests.md).
 *
 *   node scripts/test-report.mjs <coverage-summary.json> <vitest-results.json> [<repo root>]
 *
 * Reads Vitest's `json-summary` coverage report and its `json` reporter output.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ lines: { total: number, covered: number, pct: number } }} FileCoverage
 * @typedef {Record<string, FileCoverage> & { total: FileCoverage }} CoverageSummary
 * @typedef {{ testResults: { name: string, startTime: number, endTime: number }[] }} VitestResults
 */

/**
 * The area a source file counts in: the gateway by folder, a package or app by name.
 * @param {string} file path from the repository root
 * @returns {string}
 */
export function areaOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'apps' && parts[1] === 'gateway' && parts[2] === 'src') {
    return parts[3] === 'server' && parts.length > 5
      ? `apps/gateway/src/server/${parts[4]}`
      : `apps/gateway/src/${parts[3]}`;
  }
  if (parts[0] === 'plugins') return 'plugins';
  return parts.slice(0, 2).join('/');
}

/**
 * Lines covered per area, the least covered first.
 * @param {CoverageSummary} summary
 * @param {string} root
 * @returns {{ area: string, total: number, covered: number, pct: number }[]}
 */
export function coverageByArea(summary, root) {
  const areas = new Map();
  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;
    const area = areaOf(relative(root, key));
    const sum = areas.get(area) ?? { total: 0, covered: 0 };
    sum.total += entry.lines.total;
    sum.covered += entry.lines.covered;
    areas.set(area, sum);
  }
  return [...areas]
    .filter(([, { total }]) => total > 0)
    .map(([area, { total, covered }]) => ({ area, total, covered, pct: (100 * covered) / total }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total);
}

/**
 * The slowest test files, from Vitest's `json` reporter.
 * @param {VitestResults} results
 * @param {string} root
 * @returns {{ file: string, ms: number }[]}
 */
export function slowestFiles(results, root, count = 20) {
  return results.testResults
    .map((r) => ({ file: relative(root, r.name), ms: r.endTime - r.startTime }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count);
}

/**
 * @param {CoverageSummary} summary
 * @param {VitestResults} results
 * @param {string} root
 */
export function renderReport(summary, results, root) {
  const total = summary.total.lines;
  const lines = [
    '## Test report',
    '',
    `Lines covered: **${total.pct.toFixed(1)} %** (${total.covered} of ${total.total}). Information, no threshold.`,
    '',
    '| Area | Lines | Covered |',
    '| --- | ---: | ---: |',
    ...coverageByArea(summary, root).map(
      (a) => `| ${a.area} | ${a.total} | ${a.pct.toFixed(1)} % |`,
    ),
    '',
    '### Slowest test files',
    '',
    '| File | Seconds |',
    '| --- | ---: |',
    ...slowestFiles(results, root).map((s) => `| ${s.file} | ${(s.ms / 1000).toFixed(1)} |`),
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [summaryPath, resultsPath, root = process.cwd()] = process.argv.slice(2);
  if (!summaryPath || !resultsPath) {
    console.error(
      'usage: node scripts/test-report.mjs <coverage-summary.json> <vitest-results.json> [<repo root>]',
    );
    process.exit(64);
  }
  const summary = /** @type {CoverageSummary} */ (JSON.parse(readFileSync(summaryPath, 'utf8')));
  const results = /** @type {VitestResults} */ (JSON.parse(readFileSync(resultsPath, 'utf8')));
  process.stdout.write(renderReport(summary, results, resolve(root)));
}
