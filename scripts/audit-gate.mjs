#!/usr/bin/env node
/**
 * Dependency audit gate (CI job "audit"; the release pipeline calls ci.yml, so
 * it gates releases too).
 *
 *   node scripts/audit-gate.mjs [--allowlist .github/audit-allowlist.json]
 *
 * Runs `npm audit --omit=dev --json` and compares the advisories it reports
 * with a reviewed allowlist. Three outcomes, never confused:
 *
 *   advisory found       exit 1   an advisory of the gated severities that the
 *                                 allowlist does not name, or whose review
 *                                 date has passed
 *   clean                exit 0   nothing, or only allowlisted advisories
 *   registry unreachable exit 0   with a warning: the audit endpoint did not
 *                                 answer after the retries. A registry outage
 *                                 is not a vulnerability and must not block a
 *                                 merge or a release; the next run audits.
 *
 * Anything else that goes wrong (unreadable allowlist, output that is neither a
 * report nor a registry error) is exit 2: a broken gate is fixed, not ignored.
 *
 * The decision is `decide()` in this file, pure and unit-tested
 * (scripts/audit-gate.test.mjs). Handbook: docs/workflow/coding-workflow.md,
 * "Dependency audit".
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWLIST = '.github/audit-allowlist.json';
/** Severities that fail the gate when not allowlisted (the documented ones). */
export const GATED_SEVERITIES = ['moderate', 'high', 'critical'];
/**
 * Severities that are listed, not gated. Everything else is gated: a severity this
 * script does not know (`unknown`, a level npm adds one day) is not read as harmless.
 */
export const UNGATED_SEVERITIES = ['info', 'low'];
export const ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/** npm error codes and messages that mean "the registry did not answer", not "the tree is bad". */
const REGISTRY_ERROR_CODES =
  /^(E5\d\d|E429|E408|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_TIMEOUT|FETCH_ERROR|UND_ERR_[A-Z_]+|ENOAUDIT)$/;
const REGISTRY_ERROR_TEXT =
  /audit endpoint returned an error|request to https?:\/\/\S+ failed|socket hang up|network (?:timeout|error)|getaddrinfo|5\d\d (?:Internal|Bad Gateway|Service Unavailable|Gateway Time)/i;

const GHSA = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/;

/**
 * @typedef {object} Advisory
 * @property {string} id GHSA id, or `npm:<source>` when the advisory has none
 * @property {string} package
 * @property {string} severity
 * @property {string} title
 * @property {string} url
 * @property {string} range
 *
 * @typedef {object} AllowlistEntry
 * @property {string} id
 * @property {string} package
 * @property {string} reason
 * @property {string} reviewed YYYY-MM-DD
 * @property {string} review_by YYYY-MM-DD
 *
 * @typedef {{ kind: 'report', advisories: Advisory[] }
 *   | { kind: 'registry-error', detail: string }
 *   | { kind: 'unreadable', detail: string }} AuditOutcome
 *
 * @typedef {{ ok: true, entries: AllowlistEntry[] } | { ok: false, problems: string[] }} ParsedAllowlist
 *
 * @typedef {object} Verdict
 * @property {{ advisory: Advisory, why: string }[]} failures
 * @property {{ advisory: Advisory, entry: AllowlistEntry }[]} allowed
 * @property {Advisory[]} notices
 * @property {AllowlistEntry[]} unused
 */

/**
 * What one run of `npm audit --json` said.
 *   { kind: 'report', advisories: [{ id, package, severity, title, url, range }] }
 *   { kind: 'registry-error', detail }
 *   { kind: 'unreadable', detail }
 *
 * @param {string} stdout
 * @returns {AuditOutcome}
 */
export function parseAuditOutput(stdout) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const text = String(stdout).trim();
    // A registry outage is recognised on what was written, never on silence: no output
    // at all is `npm` missing, killed or crashed, and that is a broken gate (exit 2).
    if (text === '') return { kind: 'unreadable', detail: 'npm audit produced no output' };
    if (REGISTRY_ERROR_TEXT.test(text)) {
      return { kind: 'registry-error', detail: text.slice(0, 300) };
    }
    return { kind: 'unreadable', detail: text.slice(0, 300) };
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const code = String(parsed.error.code ?? '');
    const summary = String(parsed.error.summary ?? parsed.error.detail ?? '');
    if (REGISTRY_ERROR_CODES.test(code) || REGISTRY_ERROR_TEXT.test(summary)) {
      return { kind: 'registry-error', detail: `${code} ${summary}`.trim().slice(0, 300) };
    }
    return { kind: 'unreadable', detail: `${code} ${summary}`.trim().slice(0, 300) };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.vulnerabilities !== 'object') {
    return { kind: 'unreadable', detail: 'no `vulnerabilities` in the report' };
  }
  /** @type {Map<string, Advisory>} */
  const byId = new Map();
  for (const [name, entry] of /** @type {[string, any][]} */ (
    Object.entries(parsed.vulnerabilities)
  )) {
    for (const via of entry?.via ?? []) {
      // A string names another package of the report: its own entry carries the advisory.
      if (!via || typeof via !== 'object') continue;
      const url = String(via.url ?? '');
      const id = GHSA.exec(url)?.[0] ?? `npm:${String(via.source ?? url)}`;
      const pkg = String(via.name ?? name);
      // One advisory can name several packages: each pair is compared with the allowlist.
      const key = `${id}|${pkg}`;
      if (byId.has(key)) continue;
      byId.set(key, {
        id,
        package: pkg,
        severity: String(via.severity ?? entry.severity ?? 'unknown'),
        title: String(via.title ?? ''),
        url,
        range: String(via.range ?? ''),
      });
    }
  }
  return {
    kind: 'report',
    advisories: [...byId.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.package.localeCompare(b.package),
    ),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The allowlist as data, or the list of what is wrong with it.
 *
 * @param {string} text
 * @returns {ParsedAllowlist}
 */
export function parseAllowlist(text) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const entries = parsed?.advisories;
  if (!Array.isArray(entries)) return { ok: false, problems: ['`advisories` must be an array'] };
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const at = `advisories[${index}]`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${at}: must be an object`);
      continue;
    }
    if (
      typeof entry.id !== 'string' ||
      !GHSA.test(entry.id) ||
      GHSA.exec(entry.id)?.[0] !== entry.id
    ) {
      problems.push(`${at}.id: must be one GHSA id (GHSA-xxxx-xxxx-xxxx)`);
    } else if (seen.has(entry.id)) {
      problems.push(`${at}.id: ${entry.id} is listed twice`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.package !== 'string' || entry.package === '') {
      problems.push(`${at}.package: required`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
      problems.push(`${at}.reason: say why it does not apply here (40 characters at least)`);
    }
    for (const key of ['reviewed', 'review_by']) {
      const value = entry[key];
      if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        problems.push(`${at}.${key}: must be a date, YYYY-MM-DD`);
      }
    }
    if (
      typeof entry.reviewed === 'string' &&
      typeof entry.review_by === 'string' &&
      entry.review_by <= entry.reviewed
    ) {
      problems.push(`${at}.review_by: must be after \`reviewed\``);
    }
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, entries: /** @type {AllowlistEntry[]} */ (entries) };
}

/**
 * The verdict. `today` is `YYYY-MM-DD`.
 *   failures  advisories that fail the gate, each with why
 *   allowed   allowlisted advisories that were reported
 *   notices   reported, not gated (below the gated severities)
 *   unused    allowlist entries no advisory matched in this tree (prune them once
 *             every environment agrees: an optional dependency may be absent here)
 *
 * @param {Advisory[]} advisories
 * @param {AllowlistEntry[]} entries
 * @param {string} today
 * @returns {Verdict}
 */
export function decide(advisories, entries, today) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  /** @type {Verdict['failures']} */
  const failures = [];
  /** @type {Verdict['allowed']} */
  const allowed = [];
  /** @type {Advisory[]} */
  const notices = [];
  const matched = new Set();
  for (const advisory of advisories) {
    const entry = byId.get(advisory.id);
    if (entry) matched.add(entry.id);
    if (UNGATED_SEVERITIES.includes(advisory.severity)) {
      notices.push(advisory);
      continue;
    }
    if (!entry) {
      failures.push({ advisory, why: 'not in the allowlist' });
    } else if (entry.package !== advisory.package) {
      failures.push({
        advisory,
        why: `the allowlist names it for package "${entry.package}", the report for "${advisory.package}"`,
      });
    } else if (entry.review_by < today) {
      failures.push({
        advisory,
        why: `its review lapsed on ${entry.review_by}: look at it again, then move \`reviewed\` and \`review_by\``,
      });
    } else {
      allowed.push({ advisory, entry });
    }
  }
  return {
    failures,
    allowed,
    notices,
    unused: entries.filter((entry) => !matched.has(entry.id)),
  };
}

function runAudit() {
  return new Promise((resolveRun) => {
    execFile(
      'npm',
      ['audit', '--omit=dev', '--json'],
      { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' } },
      // `npm audit` exits 1 when it found something: the report on stdout decides, not the
      // code. A process that could not be started or was killed wrote nothing to decide
      // on: its error is kept, so the gate says why it is broken.
      (error, stdout, stderr) =>
        resolveRun({
          stdout: String(stdout),
          stderr: String(stderr),
          spawnError:
            error && (typeof error.code === 'string' || error.signal)
              ? `npm could not run (${error.code ?? error.signal})`
              : null,
        }),
    );
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const annotate = (level, message) => {
  // GitHub Actions annotation; a plain line anywhere else.
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`);
};

async function main(argv) {
  const flag = argv.indexOf('--allowlist');
  const path = resolve(flag >= 0 ? (argv[flag + 1] ?? DEFAULT_ALLOWLIST) : DEFAULT_ALLOWLIST);
  let allowlist;
  try {
    allowlist = parseAllowlist(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(
      `audit gate: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  if (!allowlist.ok) {
    console.error(`audit gate: ${path} is not a valid allowlist:`);
    for (const problem of allowlist.problems) console.error(`  - ${problem}`);
    return 2;
  }

  let outcome = { kind: 'registry-error', detail: 'not run' };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const { stdout, stderr, spawnError } = await runAudit();
    outcome = spawnError
      ? { kind: 'unreadable', detail: spawnError }
      : parseAuditOutput(stdout.trim() === '' ? stderr : stdout);
    if (outcome.kind !== 'registry-error') break;
    if (attempt < ATTEMPTS) {
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1);
      console.log(
        `audit gate: the registry did not answer (${outcome.detail}); retry in ${wait / 1000} s`,
      );
      await sleep(wait);
    }
  }
  if (outcome.kind === 'registry-error') {
    annotate(
      'warning',
      `Dependency audit NOT performed: the npm registry did not answer after ${ATTEMPTS} attempts (${outcome.detail}). No advisory was checked by this run.`,
    );
    return 0;
  }
  if (outcome.kind === 'unreadable') {
    console.error(`audit gate: cannot read the output of npm audit: ${outcome.detail}`);
    return 2;
  }

  const today = new Date().toISOString().slice(0, 10);
  const verdict = decide(outcome.advisories, allowlist.entries, today);
  for (const { advisory, entry } of verdict.allowed) {
    console.log(
      `allowed   ${advisory.id} ${advisory.package} (${advisory.severity}) — review by ${entry.review_by}: ${entry.reason}`,
    );
  }
  for (const advisory of verdict.notices) {
    console.log(
      `notice    ${advisory.id} ${advisory.package} (${advisory.severity}) — ${advisory.title}`,
    );
  }
  for (const entry of verdict.unused) {
    annotate(
      'notice',
      `audit allowlist: ${entry.id} (${entry.package}) matched no advisory in this dependency tree`,
    );
  }
  for (const { advisory, why } of verdict.failures) {
    annotate(
      'error',
      `${advisory.id} ${advisory.package} ${advisory.range} (${advisory.severity}) — ${advisory.title} — ${why}. ${advisory.url}`,
    );
  }
  if (verdict.failures.length > 0) {
    console.error(
      `audit gate: ${verdict.failures.length} advisory(ies) to handle: upgrade the dependency, or review it and add it to ${DEFAULT_ALLOWLIST} with a reason and a review date.`,
    );
    return 1;
  }
  console.log(
    `audit gate: clean (${verdict.allowed.length} allowlisted, ${verdict.notices.length} below the gate).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
