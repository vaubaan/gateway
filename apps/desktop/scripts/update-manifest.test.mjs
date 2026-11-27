import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NOTES_MAX_CHARS,
  archiveName,
  buildManifest,
  isSecurityRelease,
  plainText,
  updateNotes,
} from './update-manifest.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

## [2.0.0-alpha.33] - 2026-11-30

### Highlights

- **The app updates itself**, with [its notes](https://example.com).

### Added

- \`latest.json\` beside the .dmg files.

## [2.0.0-alpha.32] - 2026-11-28

### Fixed

- Something.

### Security

- **Next.js 16.4.7**, for an advisory.
`;

describe('update manifest', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('makes markdown plain for a dialog', () => {
    expect(plainText('### Added\n\n- **Bold** `code` [text](https://x.y)')).toBe(
      'Added:\n\n- Bold code text',
    );
  });

  it('keeps the highlights when the section has some, and links the release', () => {
    const notes = updateNotes(
      '### Highlights\n\n- One.\n\n### Added\n\n- Two.\n',
      'https://github.com/o/r/releases/tag/v1.0.0',
    );
    expect(notes).toBe('- One.\n\nAll the notes: https://github.com/o/r/releases/tag/v1.0.0');
  });

  it('cuts long notes at a line', () => {
    const long = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n');
    const notes = updateNotes(long, 'https://r');
    expect(notes.length).toBeLessThan(NOTES_MAX_CHARS + 40);
    expect(notes).toMatch(/- line \d+\n…\n\nAll the notes: https:\/\/r$/);
  });

  it('marks a security release by its heading or a gateway advisory it fixes', () => {
    expect(isSecurityRelease('### Security\n\n- x', [], '1.0.0')).toBe(true);
    expect(isSecurityRelease('### Fixed\n\n- x', [], '1.0.0')).toBe(false);
    const advisories = [
      { subject: 'plugin:github', fixed: '1.0.0' },
      { subject: 'gateway', fixed: '1.0.1' },
    ];
    expect(isSecurityRelease('### Fixed', advisories, '1.0.0')).toBe(false);
    expect(isSecurityRelease('### Fixed', advisories, '1.0.1')).toBe(true);
  });

  it('writes one signed archive per architecture, and refuses a missing one', () => {
    dir = mkdtempSync(join(tmpdir(), 'update-manifest-'));
    const version = '2.0.0-alpha.32';
    writeFileSync(join(dir, archiveName(version, 'arm64')), 'a');
    writeFileSync(join(dir, `${archiveName(version, 'arm64')}.sig`), 'sig-arm64\n');
    const input = {
      version,
      repository: 'vaubaan/gateway',
      dir,
      changelog: CHANGELOG,
      advisories: [],
      date: new Date('2026-11-28T10:00:00.123Z'),
    };
    expect(() => buildManifest(input)).toThrow(/x64\.app\.tar\.gz or its \.sig is missing/);

    writeFileSync(join(dir, archiveName(version, 'x64')), 'b');
    writeFileSync(join(dir, `${archiveName(version, 'x64')}.sig`), 'sig-x64');
    const manifest = buildManifest(input);
    expect(manifest).toEqual({
      version,
      notes: expect.stringContaining(
        'All the notes: https://github.com/vaubaan/gateway/releases/tag/v2.0.0-alpha.32',
      ),
      pub_date: '2026-11-28T10:00:00Z',
      security: true,
      platforms: {
        'darwin-aarch64': {
          signature: 'sig-arm64',
          url: 'https://github.com/vaubaan/gateway/releases/download/v2.0.0-alpha.32/Vaubaan-2.0.0-alpha.32-arm64.app.tar.gz',
        },
        'darwin-x86_64': {
          signature: 'sig-x64',
          url: 'https://github.com/vaubaan/gateway/releases/download/v2.0.0-alpha.32/Vaubaan-2.0.0-alpha.32-x64.app.tar.gz',
        },
      },
    });
    expect(manifest.notes).toMatch(/^Fixed:\n\n- Something\.\n\nSecurity:/);
  });

  it('refuses a version without its changelog section', () => {
    dir = mkdtempSync(join(tmpdir(), 'update-manifest-'));
    expect(() =>
      buildManifest({
        version: '2.0.0-alpha.40',
        repository: 'o/r',
        dir,
        changelog: CHANGELOG,
        advisories: [],
        date: new Date(),
      }),
    ).toThrow(/no section/);
  });
});
