/**
 * The catalog versions this release knows (`catalog-versions.json`, ADR
 * plugins-installed-when-first-needed): what an instance installs when the versions feed
 * names none, and at a start for the plugins its accounts need. Each is pinned by its
 * archive's sha256 and is the repository's version of the plugin — the version this
 * release was tested with; the plugins only the server runs are never listed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { gt } from 'semver';
import { describe, expect, it } from 'vitest';

import { KNOWN_CATALOG_VERSIONS } from '../../../src/server/plugins/catalog';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const PLUGINS = join(import.meta.dirname, '../../../../../plugins');
const repositoryVersion = (id: string): string | undefined => {
  try {
    return (
      JSON.parse(readFileSync(join(PLUGINS, id, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return undefined;
  }
};

/**
 * New plugins of the repository the catalog has not published yet: their
 * catalog pull request names a commit of `main`, so they reach `main` before
 * the catalog can sign them, and `release:prepare` lists them at the first
 * gateway release after that.
 */
const AWAITING_FIRST_CATALOG_RELEASE: ReadonlySet<string> = new Set(['google-drive', 'onedrive']);

describe('the catalog versions this release knows', () => {
  it('pins each archive by its sha256', () => {
    for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
      expect(known.sha256, id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives each service the name its plugin says', () => {
    for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
      const repository = REPOSITORY_PLUGINS.find((p) => p.id === id);
      if (repository !== undefined) expect(known.name, id).toBe(repository.displayName);
      else expect(known.name.trim(), id).not.toBe('');
    }
  });

  it('never names a version newer than the repository holds for an official plugin', () => {
    for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
      const repository = repositoryVersion(id);
      if (repository === undefined) continue;
      expect(
        gt(known.version, repository),
        `${id}: the catalog's ${known.version} is newer than plugins/${id} (${repository})`,
      ).toBe(false);
    }
  });

  it('names none of the plugins awaiting their first catalog release', () => {
    // Once the catalog published one, `release:prepare` lists it: take it off the list below.
    for (const id of AWAITING_FIRST_CATALOG_RELEASE) {
      expect([...KNOWN_CATALOG_VERSIONS.keys()], id).not.toContain(id);
    }
  });

  it('covers every plugin of the repository the catalog declares, never vaubaan nor ssh', () => {
    const ids = [...KNOWN_CATALOG_VERSIONS.keys()];
    expect(ids).not.toContain('vaubaan');
    expect(ids).not.toContain('ssh');
    const repository = readdirSync(PLUGINS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .filter((id) => id !== 'vaubaan' && id !== 'ssh' && !AWAITING_FIRST_CATALOG_RELEASE.has(id));
    for (const id of repository) expect(ids, `plugins/${id}`).toContain(id);
  });
});
