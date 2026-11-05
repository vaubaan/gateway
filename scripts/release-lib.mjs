// Release helpers shared by `npm run release:prepare` and the release workflow
// (.github/workflows/release.yml). Pure functions over text: no file, no git,
// no network — the two command-line scripts next to this file do the I/O.
//
// Policy: docs/workflow/coding-workflow.md ("Release") and the amendment
// "Release" of docs/decisions/repository-layout-and-contribution-workflow.md.

/** A problem the release scripts report by its message, without a stack trace. */
export class ReleaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** Pre-release stages in the order they are cut; `<stage>.<n>` is the only accepted form. */
export const PRERELEASE_STAGES = Object.freeze(['alpha', 'beta', 'rc']);

/** GitHub refuses a release body longer than this (characters). */
export const RELEASE_BODY_MAX_CHARS = 125000;

const NUMBER = '(0|[1-9][0-9]{0,4})';
const VERSION_PATTERN = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${PRERELEASE_STAGES.join('|')})\\.${NUMBER})?$`,
);
const SECTION_HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FENCE = /^(```|~~~)/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+\s*$/;
const UNRELEASED = 'Unreleased';

/**
 * @typedef {object} Version
 * @property {string} raw
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {{ stage: string, number: number } | null} prerelease
 */

/**
 * Parses `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-<alpha|beta|rc>.<n>`.
 * No leading `v`, no build metadata: this is the form `package.json` carries.
 * @param {string} text
 * @returns {Version}
 */
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new ReleaseError(
      `"${text}" is not a release version: expected MAJOR.MINOR.PATCH or ` +
        `MAJOR.MINOR.PATCH-<${PRERELEASE_STAGES.join('|')}>.<n> (for example 2.1.0 or 2.1.0-rc.1)`,
    );
  }
  const [, major, minor, patch, stage, number] = match;
  return {
    raw: text,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: stage === undefined ? null : { stage, number: Number(number) },
  };
}

/**
 * @param {Version} version
 * @returns {string}
 */
export function coreOf(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Semver precedence: negative when `a` comes before `b`. A pre-release comes
 * before its final version; stages order as alpha < beta < rc.
 * @param {Version} a
 * @param {Version} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease === null || b.prerelease === null) {
    return (a.prerelease === null ? 1 : 0) - (b.prerelease === null ? 1 : 0);
  }
  return (
    PRERELEASE_STAGES.indexOf(a.prerelease.stage) - PRERELEASE_STAGES.indexOf(b.prerelease.stage) ||
    a.prerelease.number - b.prerelease.number
  );
}

/**
 * The version a tag names: `v2.1.0` → `2.1.0`.
 * @param {string} tag
 * @returns {Version}
 */
export function versionOfTag(tag) {
  if (!tag.startsWith('v')) {
    throw new ReleaseError(`tag "${tag}" does not start with "v" (release tags are v<version>)`);
  }
  return parseVersion(tag.slice(1));
}

/**
 * Image tags a release publishes. A final release moves `<major>.<minor>` and
 * `latest`; a pre-release publishes its own version and nothing else.
 * @param {Version} version
 * @returns {string[]}
 */
export function imageTags(version) {
  if (version.prerelease !== null) return [version.raw];
  return [version.raw, `${version.major}.${version.minor}`, 'latest'];
}

/**
 * The architectures a release is built for, each on a hosted runner of its
 * own architecture (no emulation). `node_arch` is what `process.arch` answers
 * there; the container smoke test checks it.
 */
export const ARCHITECTURES = Object.freeze([
  Object.freeze({ arch: 'amd64', runner: 'ubuntu-24.04', node_arch: 'x64' }),
  Object.freeze({ arch: 'arm64', runner: 'ubuntu-24.04-arm', node_arch: 'arm64' }),
]);

/**
 * @typedef {object} PublicationScope
 * @property {readonly { arch: string, runner: string, node_arch: string }[]} architectures
 *   the matrix of the `image` and `push` jobs
 * @property {boolean} attestation whether `publish` signs and verifies a
 *   build-provenance attestation
 * @property {readonly string[]} leftOut what this repository does not get, and
 *   why — one Markdown sentence each, for the run summary and the release notes
 */

/**
 * What a run of the release workflow publishes from this repository. A public
 * repository gets the whole plan. A private one gets what GitHub gives it:
 * no `ubuntu-24.04-arm` hosted runner (a job asking for one on a plan without
 * it waits for a runner that never comes) and no artifact attestation (public
 * repositories, or Enterprise Cloud). So it ships `linux/amd64` only, without
 * a build-provenance attestation, and says so — never silently. Everything
 * else — gates, smoke tests, scan, SBOMs, image index, version tag, GitHub
 * release — is the same.
 * @param {{ privateRepository: boolean }} input
 * @returns {PublicationScope}
 */
export function publicationScope({ privateRepository }) {
  if (!privateRepository) {
    return { architectures: ARCHITECTURES, attestation: true, leftOut: [] };
  }
  return {
    architectures: ARCHITECTURES.filter((architecture) => architecture.arch === 'amd64'),
    attestation: false,
    leftOut: [
      'The `linux/arm64` image: GitHub offers the `ubuntu-24.04-arm` hosted runner to public ' +
        'repositories; on a private repository without a plan that includes it, the job would ' +
        'wait forever for a runner. The image is `linux/amd64` only.',
      'The build-provenance attestation: GitHub offers artifact attestations to public ' +
        'repositories and, among private ones, to GitHub Enterprise Cloud only. There is nothing ' +
        "to `gh attestation verify`; BuildKit's provenance and SBOM inside the image, and the SPDX " +
        'SBOM of the release, are unaffected.',
    ],
  };
}

/**
 * The platforms of a scope, for prose: "`linux/amd64` and `linux/arm64`".
 * @param {PublicationScope} scope
 * @returns {string}
 */
export function platformsText(scope) {
  return scope.architectures.map((architecture) => `\`linux/${architecture.arch}\``).join(' and ');
}

/**
 * The tag being released must name the version of `package.json` and be the
 * highest release so far: `latest` and `<major>.<minor>` only move forward.
 * @param {{ tag: string, manifestVersion: string, existingTags: readonly string[] }} input
 * @returns {Version}
 */
export function assertReleasableTag({ tag, manifestVersion, existingTags }) {
  const version = versionOfTag(tag);
  if (version.raw !== manifestVersion) {
    throw new ReleaseError(
      `tag ${tag} does not match the version in package.json (${manifestVersion}); ` +
        `run "npm run release:prepare -- ${version.raw}" and tag the commit that carries it`,
    );
  }
  for (const other of existingTags) {
    if (other === tag) continue;
    let otherVersion;
    try {
      otherVersion = versionOfTag(other);
    } catch {
      continue; // not a release tag (v4-final, …)
    }
    if (compareVersions(otherVersion, version) > 0) {
      throw new ReleaseError(
        `tag ${tag} is older than the existing release ${other}; releases only move forward ` +
          `(no maintenance branch is published)`,
      );
    }
  }
  return version;
}

/**
 * @typedef {object} Section
 * @property {string} name      text between the brackets of the `## [name]` heading
 * @property {string | null} date
 * @property {number} start     index of the heading line
 * @property {number} end       index of the first line after the section
 */

/**
 * Index of the first line of the trailing block of `[name]: url` definitions.
 * @param {string[]} lines
 * @returns {number}
 */
function linkFooterStart(lines) {
  let index = lines.length;
  while (index > 0) {
    const line = lines[index - 1] ?? '';
    if (line.trim() === '' || LINK_DEFINITION.test(line)) index -= 1;
    else break;
  }
  return index;
}

/**
 * Splits a Keep a Changelog file into its `## [name]` sections. Headings
 * inside fenced code blocks are text, and the link reference definitions that
 * close the file belong to no section.
 * @param {string[]} lines
 * @returns {Section[]}
 */
function sectionsOf(lines) {
  /** @type {Section[]} */
  const sections = [];
  const footer = linkFooterStart(lines);
  let fenced = false;
  for (let index = 0; index < footer; index += 1) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = SECTION_HEADING.exec(line);
    if (!match) continue;
    const previous = sections.at(-1);
    if (previous) previous.end = index;
    sections.push({ name: match[1] ?? '', date: match[2] ?? null, start: index, end: footer });
  }
  return sections;
}

/**
 * @param {string[]} lines
 * @param {Section} section
 * @returns {string}
 */
function bodyOf(lines, section) {
  return lines
    .slice(section.start + 1, section.end)
    .join('\n')
    .trim();
}

/**
 * Sections of the pre-releases of `version` (same MAJOR.MINOR.PATCH), newest first.
 * @param {Section[]} sections
 * @param {Version} version
 * @returns {Section[]}
 */
function prereleasesOf(sections, version) {
  /** @type {{ section: Section, parsed: Version }[]} */
  const found = [];
  for (const section of sections) {
    let parsed;
    try {
      parsed = parseVersion(section.name);
    } catch {
      continue; // "Unreleased", or a heading that is not a version
    }
    if (parsed.prerelease !== null && coreOf(parsed) === coreOf(version)) {
      found.push({ section, parsed });
    }
  }
  return found.sort((a, b) => compareVersions(b.parsed, a.parsed)).map((entry) => entry.section);
}

/**
 * The body of the GitHub release of `versionText`, taken from the changelog.
 *
 * A final release that follows pre-releases also carries their sections,
 * newest first, under their own headings: its own section only holds what
 * changed since the last pre-release.
 *
 * Refuses a version whose section is missing (naming `Unreleased` when the
 * changes are still there), undated or empty.
 * @param {string} changelog
 * @param {string} versionText
 * @returns {string}
 */
export function extractReleaseNotes(changelog, versionText) {
  const version = parseVersion(versionText);
  const lines = changelog.split('\n');
  const sections = sectionsOf(lines);
  const own = sections.find((section) => section.name === version.raw);
  if (!own) {
    const unreleased = sections.find((section) => section.name === UNRELEASED);
    const hint =
      unreleased && bodyOf(lines, unreleased) !== ''
        ? `the changes are still titled "${UNRELEASED}"`
        : `and "${UNRELEASED}" is empty`;
    throw new ReleaseError(
      `CHANGELOG.md has no section "## [${version.raw}] - <date>"; ${hint}. ` +
        `Run "npm run release:prepare -- ${version.raw}" and commit before tagging.`,
    );
  }
  if (own.date === null) {
    throw new ReleaseError(
      `CHANGELOG.md section [${version.raw}] has no date; expected "## [${version.raw}] - YYYY-MM-DD"`,
    );
  }
  const parts = [];
  const ownBody = bodyOf(lines, own);
  if (ownBody !== '') parts.push(ownBody);
  if (version.prerelease === null) {
    for (const section of prereleasesOf(sections, version)) {
      const body = bodyOf(lines, section);
      if (body === '') continue;
      parts.push(`## ${section.name}${section.date ? ` - ${section.date}` : ''}\n\n${body}`);
    }
  }
  if (parts.length === 0) {
    throw new ReleaseError(`CHANGELOG.md section [${version.raw}] is empty; a release has notes`);
  }
  const notes = parts.join('\n\n');
  if (notes.length > RELEASE_BODY_MAX_CHARS) {
    throw new ReleaseError(
      `the release notes of ${version.raw} are ${notes.length} characters long; GitHub accepts ` +
        `${RELEASE_BODY_MAX_CHARS}. Shorten the CHANGELOG.md section.`,
    );
  }
  return `${notes}\n`;
}

/**
 * The body of `Unreleased`, for the preview a dry run prints. Empty when
 * nothing is pending.
 * @param {string} changelog
 * @returns {string}
 */
export function unreleasedNotes(changelog) {
  const lines = changelog.split('\n');
  const unreleased = sectionsOf(lines).find((section) => section.name === UNRELEASED);
  return unreleased ? bodyOf(lines, unreleased) : '';
}

const UNRELEASED_LINK = /^\[Unreleased\]:\s+(\S+)\/compare\/(\S+)\.\.\.HEAD\s*$/;

/**
 * Rewrites `[Unreleased]: <repo>/compare/<previous>...HEAD` into the pair
 * Keep a Changelog expects. The repository URL is read from the existing
 * line, never written here.
 * @param {string[]} tail
 * @param {Version} version
 * @returns {string[]}
 */
function withCompareLinks(tail, version) {
  return tail.flatMap((line) => {
    const match = UNRELEASED_LINK.exec(line);
    if (!match) return [line];
    const [, repository, previous] = match;
    const tag = `v${version.raw}`;
    return [
      `[Unreleased]: ${repository}/compare/${tag}...HEAD`,
      `[${version.raw}]: ${repository}/compare/${previous}...${tag}`,
    ];
  });
}

/**
 * Moves the content of `Unreleased` under `## [version] - date` and leaves an
 * empty `Unreleased` above it. Updates the compare links that close the file
 * when they are there.
 *
 * `Unreleased` may be empty only for a final release that follows
 * pre-releases of the same version (promoting a release candidate unchanged).
 * @param {string} changelog
 * @param {string} versionText
 * @param {string} date  YYYY-MM-DD
 * @returns {string}
 */
export function prepareChangelog(changelog, versionText, date) {
  const version = parseVersion(versionText);
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ReleaseError(`"${date}" is not a date; expected YYYY-MM-DD`);
  }
  const lines = changelog.split('\n');
  const sections = sectionsOf(lines);
  const unreleased = sections.find((section) => section.name === UNRELEASED);
  if (!unreleased) {
    throw new ReleaseError(`CHANGELOG.md has no "## [${UNRELEASED}]" section to release`);
  }
  if (sections.some((section) => section.name === version.raw)) {
    throw new ReleaseError(`CHANGELOG.md already has a section [${version.raw}]`);
  }
  let body = bodyOf(lines, unreleased);
  if (body === '') {
    const promoted = version.prerelease === null ? prereleasesOf(sections, version)[0] : undefined;
    if (!promoted) {
      throw new ReleaseError(
        `CHANGELOG.md "${UNRELEASED}" is empty: nothing to release as ${version.raw}`,
      );
    }
    body = `No change since ${promoted.name}.`;
  }
  const tail = lines.slice(unreleased.end);
  // The blank lines before the closing links already separate; a heading does not.
  const separator = tail.length > 0 && (tail[0] ?? '').trim() !== '' ? [''] : [];
  return [
    ...lines.slice(0, unreleased.start),
    `## [${UNRELEASED}]`,
    '',
    `## [${version.raw}] - ${date}`,
    '',
    ...body.split('\n'),
    ...separator,
    ...withCompareLinks(tail, version),
  ].join('\n');
}

const MANIFEST_VERSION = /^(\s*"version":\s*")([^"]*)(")/m;

/**
 * Sets the top-level `version` of a `package.json` text, keeping every other
 * byte (the first `"version"` key of the file is the package's own).
 * @param {string} manifest
 * @param {string} versionText
 * @returns {string}
 */
export function bumpManifest(manifest, versionText) {
  const version = parseVersion(versionText);
  if (!MANIFEST_VERSION.test(manifest)) {
    throw new ReleaseError('package.json has no "version" field');
  }
  return manifest.replace(MANIFEST_VERSION, `$1${version.raw}$3`);
}

/**
 * Sets the root version of a `package-lock.json` text (its two copies), in
 * npm's own formatting.
 * @param {string} lockfile
 * @param {string} versionText
 * @returns {string}
 */
export function bumpLockfile(lockfile, versionText) {
  const version = parseVersion(versionText);
  const lock = JSON.parse(lockfile);
  const root = lock?.packages?.[''];
  if (typeof lock?.version !== 'string' || typeof root?.version !== 'string') {
    throw new ReleaseError('package-lock.json does not carry the root package version');
  }
  lock.version = version.raw;
  root.version = version.raw;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * A release version must come after the one `package.json` carries.
 * @param {string} current
 * @param {string} next
 */
export function assertMovesForward(current, next) {
  if (compareVersions(parseVersion(next), parseVersion(current)) <= 0) {
    throw new ReleaseError(`${next} does not come after the current version ${current}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Released versions for the website's versions feed (ADR
// plugins-bundled-or-pinned-by-the-operator): `release:prepare` writes
// apps/website/src/content/releases.json, the site serves it in versions.json.
// ─────────────────────────────────────────────────────────────────────────────

/** The plugin template is never released. */
export const PLUGIN_TEMPLATE = '_template';

/**
 * @typedef {object} ReleasesData
 * @property {string} gateway the released gateway version
 * @property {boolean} prerelease
 * @property {string} date YYYY-MM-DD of the gateway release
 * @property {Record<string, string>} plugins the released version of each plugin, by id
 */

/**
 * The released versions at a gateway release: its version and every plugin's, sorted
 * by id (the template left out).
 * @param {{ gatewayVersion: string, date: string, plugins: Record<string, string> }} input
 * @returns {ReleasesData}
 */
export function releasesData({ gatewayVersion, date, plugins }) {
  const version = parseVersion(gatewayVersion);
  if (!ISO_DATE.test(date)) throw new ReleaseError(`"${date}" is not a date (YYYY-MM-DD)`);
  /** @type {Record<string, string>} */
  const sorted = {};
  for (const id of Object.keys(plugins).sort()) {
    if (id === PLUGIN_TEMPLATE) continue;
    sorted[id] = parseVersion(plugins[id] ?? '').raw;
  }
  return { gateway: version.raw, prerelease: version.prerelease !== null, date, plugins: sorted };
}

/**
 * The released versions after a plugin hotfix: that plugin's entry alone moves, and
 * only forward.
 * @param {ReleasesData} data
 * @param {string} id
 * @param {string} version
 * @returns {ReleasesData}
 */
export function withPluginRelease(data, id, version) {
  if (id === PLUGIN_TEMPLATE) throw new ReleaseError('the plugin template is never released');
  const current = data.plugins[id];
  if (current !== undefined) assertMovesForward(current, version);
  else parseVersion(version);
  return {
    ...data,
    plugins: Object.fromEntries(
      Object.entries({ ...data.plugins, [id]: version }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/**
 * Reads releases.json as `release:prepare` wrote it.
 * @param {string} text
 * @returns {ReleasesData}
 */
export function parseReleasesData(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReleaseError('releases.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReleaseError('releases.json is not an object');
  }
  const { gateway, date, plugins } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof gateway !== 'string' || typeof date !== 'string') {
    throw new ReleaseError('releases.json has no "gateway" version or no "date"');
  }
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    throw new ReleaseError('releases.json has no "plugins" object');
  }
  return releasesData({
    gatewayVersion: gateway,
    date,
    plugins: /** @type {Record<string, string>} */ (plugins),
  });
}

/**
 * releases.json as committed: two-space JSON and a final newline.
 * @param {ReleasesData} data
 * @returns {string}
 */
export function serializeReleasesData(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

const PLUGIN_TAG = /^plugin-([a-z][a-z0-9-]*)-v(.+)$/;

/**
 * The plugin and version a plugin release tag names: `plugin-cloudflare-dns-v4.0.1`.
 * @param {string} tag
 * @returns {{ id: string, version: string }}
 */
export function parsePluginTag(tag) {
  const match = PLUGIN_TAG.exec(tag);
  if (!match) {
    throw new ReleaseError(
      `tag "${tag}" is not a plugin release tag (plugin-<id>-v<version>, for example plugin-notion-v0.3.0)`,
    );
  }
  const [, id = '', version = ''] = match;
  return { id, version: parseVersion(version).raw };
}

/**
 * A plugin release tag must name the version of that plugin's package.json.
 * @param {{ tag: string, manifestVersion: string | null }} input
 * @returns {{ id: string, version: string }}
 */
export function assertPluginTag({ tag, manifestVersion }) {
  const { id, version } = parsePluginTag(tag);
  if (id === PLUGIN_TEMPLATE) throw new ReleaseError('the plugin template is never released');
  if (manifestVersion === null) throw new ReleaseError(`tag "${tag}" names no plugin of plugins/`);
  if (manifestVersion !== version) {
    throw new ReleaseError(
      `tag "${tag}" does not match the version in plugins/${id}/package.json (${manifestVersion})`,
    );
  }
  return { id, version };
}
