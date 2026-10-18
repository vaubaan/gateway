// Release helpers: version rules, image tags, changelog extraction and
// preparation on a fixture, then the two command-line scripts end to end in a
// throwaway copy of the files they touch (no git, no network).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  RELEASE_BODY_MAX_CHARS,
  ReleaseError,
  assertMovesForward,
  assertReleasableTag,
  bumpLockfile,
  bumpManifest,
  compareVersions,
  extractReleaseNotes,
  imageTags,
  parseVersion,
  platformsText,
  prepareChangelog,
  publicationScope,
  unreleasedNotes,
  versionOfTag,
} from './release-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures/CHANGELOG.fixture.md'), 'utf8');

describe('parseVersion', () => {
  it('reads a final version and the three pre-release stages', () => {
    expect(parseVersion('2.1.0')).toEqual({
      raw: '2.1.0',
      major: 2,
      minor: 1,
      patch: 0,
      prerelease: null,
    });
    expect(parseVersion('2.0.0-alpha.0').prerelease).toEqual({ stage: 'alpha', number: 0 });
    expect(parseVersion('2.0.0-beta.3').prerelease).toEqual({ stage: 'beta', number: 3 });
    expect(parseVersion('2.0.0-rc.12').prerelease).toEqual({ stage: 'rc', number: 12 });
  });

  it.each([
    'v2.1.0',
    '2.1',
    '2.1.0.1',
    '02.1.0',
    '2.1.0-rc1',
    '2.1.0-rc',
    '2.1.0-preview.1',
    '2.1.0-rc.01',
    '2.1.0+build.5',
    '2.1.0-rc.1+build',
    '',
    'latest',
  ])('refuses %j', (text) => {
    expect(() => parseVersion(text)).toThrow(ReleaseError);
  });
});

describe('compareVersions', () => {
  it('orders releases by semver precedence', () => {
    const ordered = [
      '2.0.0-alpha.0',
      '2.0.0-alpha.1',
      '2.0.0-beta.0',
      '2.0.0-rc.1',
      '2.0.0-rc.10',
      '2.0.0',
      '2.0.1',
      '2.1.0-rc.1',
      '2.1.0',
      '2.10.0',
      '3.0.0',
    ];
    const shuffled = [...ordered].reverse();
    shuffled.sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));
    expect(shuffled).toEqual(ordered);
    expect(compareVersions(parseVersion('2.1.0'), parseVersion('2.1.0'))).toBe(0);
  });
});

describe('imageTags', () => {
  it('publishes the version, the minor line and latest for a final release', () => {
    expect(imageTags(parseVersion('2.1.3'))).toEqual(['2.1.3', '2.1', 'latest']);
  });

  it.each(['2.1.0-alpha.1', '2.1.0-beta.2', '2.1.0-rc.1'])(
    'publishes only its own version for the pre-release %s',
    (text) => {
      expect(imageTags(parseVersion(text))).toEqual([text]);
    },
  );
});

describe('publicationScope', () => {
  it('a public repository gets both architectures, the attestation and nothing left out', () => {
    const scope = publicationScope({ privateRepository: false });
    expect(scope.architectures).toBe(ARCHITECTURES);
    expect(scope.architectures.map((architecture) => architecture.arch)).toEqual([
      'amd64',
      'arm64',
    ]);
    expect(scope.attestation).toBe(true);
    expect(scope.leftOut).toEqual([]);
    expect(platformsText(scope)).toBe('`linux/amd64` and `linux/arm64`');
  });

  it('a private repository gets amd64 only and no attestation, and is told why', () => {
    const scope = publicationScope({ privateRepository: true });
    expect(scope.architectures).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04', node_arch: 'x64' },
    ]);
    expect(scope.attestation).toBe(false);
    expect(scope.leftOut).toHaveLength(2);
    expect(scope.leftOut[0]).toContain('`linux/arm64`');
    expect(scope.leftOut[0]).toContain('`ubuntu-24.04-arm`');
    expect(scope.leftOut[1]).toContain('attestation');
    expect(scope.leftOut[1]).toContain('Enterprise Cloud');
    expect(platformsText(scope)).toBe('`linux/amd64`');
  });

  it('every architecture runs on a runner of its own architecture', () => {
    expect(ARCHITECTURES.find((architecture) => architecture.arch === 'arm64').runner).toBe(
      'ubuntu-24.04-arm',
    );
    expect(ARCHITECTURES.find((architecture) => architecture.arch === 'amd64').runner).toBe(
      'ubuntu-24.04',
    );
  });
});

describe('assertReleasableTag', () => {
  const existingTags = ['v4-final', 'v2.0.0', 'v2.0.1', 'v2.1.0-rc.1', 'not-a-release'];

  it('accepts the tag that names the manifest version and is the highest release', () => {
    const version = assertReleasableTag({
      tag: 'v2.1.0',
      manifestVersion: '2.1.0',
      existingTags: [...existingTags, 'v2.1.0'],
    });
    expect(version.raw).toBe('2.1.0');
  });

  it('refuses a tag that does not match package.json', () => {
    expect(() =>
      assertReleasableTag({ tag: 'v2.1.0', manifestVersion: '2.0.1', existingTags }),
    ).toThrow(/does not match the version in package\.json \(2\.0\.1\)/);
  });

  it('refuses a tag older than an existing release', () => {
    expect(() =>
      assertReleasableTag({ tag: 'v2.0.2', manifestVersion: '2.0.2', existingTags }),
    ).toThrow(/older than the existing release v2\.1\.0-rc\.1/);
  });

  it('refuses a tag that is not a release tag', () => {
    expect(() => versionOfTag('2.1.0')).toThrow(/does not start with "v"/);
    expect(() =>
      assertReleasableTag({ tag: 'v2.x.0', manifestVersion: '2.1.0', existingTags }),
    ).toThrow(ReleaseError);
  });
});

describe('extractReleaseNotes', () => {
  it('returns the body of a dated section, without its heading', () => {
    expect(extractReleaseNotes(FIXTURE, '2.0.1')).toBe('### Security\n\n- A patch release.\n');
  });

  it('stops at the next section and never takes the compare links', () => {
    const notes = extractReleaseNotes(FIXTURE, '2.1.0-rc.1');
    expect(notes).toBe('### Added\n\n- **Feature of 2.1.** First candidate.\n');
    expect(notes).not.toContain('example.com');
  });

  it('appends the pre-release sections to a final release, newest first', () => {
    expect(extractReleaseNotes(FIXTURE, '2.1.0')).toBe(
      [
        '### Changed',
        '',
        '- The final touch after the release candidate.',
        '',
        '## 2.1.0-rc.2 - 2026-11-15',
        '',
        '### Fixed',
        '',
        '- Second candidate fix.',
        '',
        '## 2.1.0-rc.1 - 2026-11-10',
        '',
        '### Added',
        '',
        '- **Feature of 2.1.** First candidate.',
        '',
      ].join('\n'),
    );
  });

  it('refuses a version whose changes are still titled Unreleased', () => {
    expect(() => extractReleaseNotes(FIXTURE, '2.2.0')).toThrow(
      /no section "## \[2\.2\.0\] - <date>"; the changes are still titled "Unreleased"/,
    );
  });

  it('refuses a missing section when Unreleased is empty too', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-10-20\n\n- First.\n';
    expect(() => extractReleaseNotes(changelog, '2.0.1')).toThrow(/and "Unreleased" is empty/);
  });

  it('refuses an undated section', () => {
    expect(() => extractReleaseNotes(FIXTURE, '2.0.0')).toThrow(/has no date/);
  });

  it('refuses an empty section', () => {
    const changelog = '# Changelog\n\n## [2.0.0] - 2026-10-20\n\n## [1.0.0] - 2026-01-01\n\n- x\n';
    expect(() => extractReleaseNotes(changelog, '2.0.0')).toThrow(/is empty/);
  });

  it('does not take a heading inside a code block for a section', () => {
    expect(() => extractReleaseNotes(FIXTURE, '9.9.9')).toThrow(/no section/);
    expect(unreleasedNotes(FIXTURE)).toContain('## [9.9.9] - 2099-01-01');
  });

  it('refuses notes GitHub would not accept', () => {
    const bullet = `- ${'x'.repeat(98)}\n`;
    const body = bullet.repeat(Math.ceil(RELEASE_BODY_MAX_CHARS / bullet.length) + 1);
    const changelog = `# Changelog\n\n## [2.0.0] - 2026-10-20\n\n${body}`;
    expect(() => extractReleaseNotes(changelog, '2.0.0')).toThrow(/GitHub accepts 125000/);
  });
});

describe('prepareChangelog', () => {
  it('moves Unreleased under a dated heading and leaves an empty Unreleased', () => {
    const prepared = prepareChangelog(FIXTURE, '2.2.0', '2026-12-01');
    expect(prepared).toContain('## [Unreleased]\n\n## [2.2.0] - 2026-12-01\n\n### Added\n');
    expect(unreleasedNotes(prepared)).toBe('');
    expect(extractReleaseNotes(prepared, '2.2.0')).toBe(`${unreleasedNotes(FIXTURE)}\n`);
    // Everything else is untouched.
    expect(extractReleaseNotes(prepared, '2.0.1')).toBe(extractReleaseNotes(FIXTURE, '2.0.1'));
    expect(prepared.split('\n').length).toBe(FIXTURE.split('\n').length + 3);
  });

  it('rewrites the compare links from the repository URL already in the file', () => {
    const prepared = prepareChangelog(FIXTURE, '2.2.0', '2026-12-01');
    expect(prepared).toContain(
      '[Unreleased]: https://example.com/acme/gateway/compare/v2.2.0...HEAD\n' +
        '[2.2.0]: https://example.com/acme/gateway/compare/v2.1.0...v2.2.0\n' +
        '[2.1.0]: https://example.com/acme/gateway/compare/v2.0.1...v2.1.0\n',
    );
  });

  it('works on a changelog without compare links', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One.\n';
    expect(prepareChangelog(changelog, '2.0.0', '2026-10-20')).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-10-20\n\n### Added\n\n- One.\n',
    );
  });

  it('refuses an empty Unreleased', () => {
    const prepared = prepareChangelog(FIXTURE, '2.2.0', '2026-12-01');
    expect(() => prepareChangelog(prepared, '2.2.1', '2026-12-02')).toThrow(/nothing to release/);
  });

  it('promotes a release candidate unchanged to its final version', () => {
    const candidate = prepareChangelog(FIXTURE, '2.2.0-rc.1', '2026-12-01');
    const final = prepareChangelog(candidate, '2.2.0', '2026-12-05');
    expect(final).toContain('## [2.2.0] - 2026-12-05\n\nNo change since 2.2.0-rc.1.\n');
    expect(extractReleaseNotes(final, '2.2.0')).toContain('## 2.2.0-rc.1 - 2026-12-01');
    expect(extractReleaseNotes(final, '2.2.0')).toContain('**Pending feature.**');
  });

  it('refuses a version that already has a section, a missing Unreleased and a bad date', () => {
    expect(() => prepareChangelog(FIXTURE, '2.1.0', '2026-12-01')).toThrow(/already has a section/);
    expect(() => prepareChangelog('# Changelog\n', '2.2.0', '2026-12-01')).toThrow(
      /no "## \[Unreleased\]" section/,
    );
    expect(() => prepareChangelog(FIXTURE, '2.2.0', '1 December')).toThrow(/is not a date/);
    expect(() => prepareChangelog(FIXTURE, '2.2.0', '2026-13-45')).toThrow(/is not a date/);
  });
});

describe('bumpManifest and bumpLockfile', () => {
  const manifest =
    '{\n  "name": "@acme/gateway",\n  "version": "2.0.0-alpha.0",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n';
  const lockfile = `${JSON.stringify(
    {
      name: '@acme/gateway',
      version: '2.0.0-alpha.0',
      lockfileVersion: 3,
      packages: {
        '': { name: '@acme/gateway', version: '2.0.0-alpha.0' },
        'node_modules/x': { version: '1.0.0' },
      },
    },
    null,
    2,
  )}\n`;

  it('changes the package version and nothing else', () => {
    expect(bumpManifest(manifest, '2.0.0')).toBe(manifest.replace('2.0.0-alpha.0', '2.0.0'));
    expect(JSON.parse(bumpManifest(manifest, '2.0.0')).dependencies).toEqual({ x: '1.0.0' });
  });

  it('changes both copies of the root version in the lockfile', () => {
    const bumped = JSON.parse(bumpLockfile(lockfile, '2.0.0'));
    expect(bumped.version).toBe('2.0.0');
    expect(bumped.packages[''].version).toBe('2.0.0');
    expect(bumped.packages['node_modules/x'].version).toBe('1.0.0');
  });

  it('refuses files without a version', () => {
    expect(() => bumpManifest('{\n  "name": "x"\n}\n', '2.0.0')).toThrow(/no "version" field/);
    expect(() => bumpLockfile('{"packages":{}}', '2.0.0')).toThrow(/root package version/);
  });
});

describe('assertMovesForward', () => {
  it('accepts a later version and refuses the same or an earlier one', () => {
    expect(() => assertMovesForward('2.0.0-alpha.0', '2.0.0-alpha.1')).not.toThrow();
    expect(() => assertMovesForward('2.0.0-rc.1', '2.0.0')).not.toThrow();
    expect(() => assertMovesForward('2.0.0', '2.0.0')).toThrow(/does not come after/);
    expect(() => assertMovesForward('2.0.0', '2.0.0-rc.1')).toThrow(/does not come after/);
  });
});

describe('the command-line scripts', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'vaubaan-release-'));
    mkdirSync(join(sandbox, 'scripts'));
    for (const script of ['release-lib.mjs', 'release-prepare.mjs', 'release-plan.mjs']) {
      cpSync(join(HERE, script), join(sandbox, 'scripts', script));
    }
    const manifest = { name: '@acme/gateway', version: '2.1.0' };
    writeFileSync(join(sandbox, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(sandbox, 'package-lock.json'),
      `${JSON.stringify({ ...manifest, packages: { '': manifest } }, null, 2)}\n`,
    );
    writeFileSync(join(sandbox, 'CHANGELOG.md'), FIXTURE);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Runs a script of the sandbox; returns its exit code and what it printed. */
  function run(script, args, { input = '', env = {} } = {}) {
    try {
      const stdout = execFileSync(process.execPath, [join(sandbox, 'scripts', script), ...args], {
        cwd: sandbox,
        input,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout, stderr: error.stderr };
    }
  }

  const read = (name) => readFileSync(join(sandbox, name), 'utf8');

  it('release:prepare edits the three files and prints the tag command without running it', () => {
    const result = run('release-prepare.mjs', ['2.2.0', '--date', '2026-12-01']);
    expect(result.code).toBe(0);
    expect(read('CHANGELOG.md')).toContain('## [Unreleased]\n\n## [2.2.0] - 2026-12-01\n');
    expect(JSON.parse(read('package.json')).version).toBe('2.2.0');
    expect(JSON.parse(read('package-lock.json')).packages[''].version).toBe('2.2.0');
    expect(result.stdout).toContain('git tag -a v2.2.0 -m "Vaubaan Gateway 2.2.0" <commit>');
    expect(result.stdout).toContain('No commit and no tag were created.');
  });

  it('release:prepare refuses a version that does not move forward and writes nothing', () => {
    const before = [read('CHANGELOG.md'), read('package.json'), read('package-lock.json')];
    const result = run('release-prepare.mjs', ['2.1.0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('2.1.0 does not come after the current version 2.1.0');
    expect([read('CHANGELOG.md'), read('package.json'), read('package-lock.json')]).toEqual(before);
  });

  it('release:prepare refuses a malformed version and a missing argument', () => {
    expect(run('release-prepare.mjs', ['v2.2.0']).stderr).toContain('is not a release version');
    expect(run('release-prepare.mjs', []).stderr).toContain('usage: npm run release:prepare');
  });

  it('the plan of a tag writes the notes and the workflow outputs', () => {
    const output = join(sandbox, 'github-output');
    writeFileSync(output, '');
    const result = run('release-plan.mjs', ['--tag', 'v2.1.0', '--notes-out', 'notes.md'], {
      input: 'v4-final\nv2.0.1\nv2.1.0-rc.2\nv2.1.0\n',
      env: { GITHUB_OUTPUT: output },
    });
    expect(result.code).toBe(0);
    expect(read('notes.md')).toBe(extractReleaseNotes(FIXTURE, '2.1.0'));
    expect(readFileSync(output, 'utf8')).toBe(
      [
        'version=2.1.0',
        'prerelease=false',
        'image_tags<<RELEASE_PLAN_EOF',
        '2.1.0',
        '2.1',
        'latest',
        'RELEASE_PLAN_EOF',
        `matrix=${JSON.stringify(ARCHITECTURES)}`,
        'architectures=amd64 arm64',
        'platforms=`linux/amd64` and `linux/arm64`',
        'attest=true',
        'left_out<<RELEASE_PLAN_EOF',
        'RELEASE_PLAN_EOF',
        '',
      ].join('\n'),
    );
    expect(result.stdout).not.toContain('::notice');
  });

  it('the plan of a private repository ships amd64 only, no attestation, and says what is left out', () => {
    const output = join(sandbox, 'github-output');
    writeFileSync(output, '');
    const result = run(
      'release-plan.mjs',
      ['--tag', 'v2.1.0', '--notes-out', 'notes.md', '--private-repository', 'true'],
      { input: 'v2.1.0\n', env: { GITHUB_OUTPUT: output } },
    );
    expect(result.code).toBe(0);
    const written = readFileSync(output, 'utf8');
    expect(written).toContain(
      'matrix=[{"arch":"amd64","runner":"ubuntu-24.04","node_arch":"x64"}]\n',
    );
    expect(written).toContain('architectures=amd64\n');
    expect(written).toContain('platforms=`linux/amd64`\n');
    expect(written).toContain('attest=false\n');
    expect(written).toMatch(
      /left_out<<RELEASE_PLAN_EOF\n- The `linux\/arm64` image.*\n- The build-provenance attestation.*\nRELEASE_PLAN_EOF\n/,
    );
    expect(
      result.stdout.match(/::notice title=Left out on this private repository::/g),
    ).toHaveLength(2);
    expect(result.stdout).toContain('architectures: amd64 (private repository)');
    expect(result.stdout).toContain('attestation:   no (private repository)');
  });

  it('the plan refuses a repository visibility it does not understand', () => {
    const result = run('release-plan.mjs', [
      '--dry-run',
      '--notes-out',
      'notes.md',
      '--private-repository',
      'maybe',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--private-repository takes true or false');
  });

  it('the plan of a tag fails while the changes are still titled Unreleased', () => {
    run('release-prepare.mjs', ['2.2.0', '--date', '2026-12-01']);
    writeFileSync(join(sandbox, 'CHANGELOG.md'), FIXTURE); // the changelog edit was not committed
    const result = run('release-plan.mjs', ['--tag', 'v2.2.0', '--notes-out', 'notes.md']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('::error title=Release refused::');
    expect(result.stderr).toContain('still titled "Unreleased"');
  });

  it('the plan of a tag fails when the tag is not the version of package.json', () => {
    const result = run('release-plan.mjs', ['--tag', 'v2.0.1', '--notes-out', 'notes.md']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not match the version in package.json (2.1.0)');
  });

  it('a dry run previews Unreleased with a warning when the section is not cut yet', () => {
    const manifest = { name: '@acme/gateway', version: '2.2.0-rc.1' };
    writeFileSync(join(sandbox, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = run('release-plan.mjs', ['--dry-run', '--notes-out', 'notes.md']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('::warning title=Release notes are a preview::');
    expect(result.stdout).toContain('image tags:    2.2.0-rc.1\n');
    expect(read('notes.md')).toBe(`${unreleasedNotes(FIXTURE)}\n`);
  });

  it('the plan needs exactly one mode and a notes file', () => {
    expect(run('release-plan.mjs', ['--notes-out', 'notes.md']).code).toBe(1);
    expect(run('release-plan.mjs', ['--dry-run']).code).toBe(1);
    expect(run('release-plan.mjs', ['--dry-run', '--tag', 'v2.1.0', '--notes-out', 'n']).code).toBe(
      1,
    );
  });
});

// The repository's own files must stay something the release can cut.
describe('the repository', () => {
  it('has an Unreleased section and a version the scripts accept', () => {
    const changelog = readFileSync(resolve(HERE, '../CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
    const version = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')).version;
    expect(() => parseVersion(version)).not.toThrow();
  });
});
