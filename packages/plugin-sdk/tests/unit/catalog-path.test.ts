import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { CATALOG_FILE_NAME, catalogPathNextTo } from '../../src/catalog-path.ts';
import { loadCatalogFile } from '../../src/catalog-loader.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('catalogPathNextTo', () => {
  test('returns the sibling path of the calling module, default file name', () => {
    expect(catalogPathNextTo(import.meta.url)).toBe(join(here, CATALOG_FILE_NAME));
    expect(catalogPathNextTo(import.meta.url, 'other.yaml')).toBe(join(here, 'other.yaml'));
  });

  test('accepts a URL object as well as the import.meta.url string', () => {
    const asUrl = pathToFileURL(join(here, 'module.ts'));
    expect(catalogPathNextTo(asUrl)).toBe(join(here, CATALOG_FILE_NAME));
  });

  test('the acme fixture resolves to an existing file the loader reads', () => {
    const fixtureModule = pathToFileURL(join(here, '../fixtures/acme/acme-plugin.ts')).href;
    const path = catalogPathNextTo(fixtureModule);
    expect(existsSync(path)).toBe(true);
    expect(loadCatalogFile(path).catalog.provider).toBe('acme');
  });

  test('rejects a module URL a bundler rewrote into an asset or http URL', () => {
    expect(() => catalogPathNextTo('https://gateway.example/_next/static/media/x.yaml')).toThrow(
      /expected a file: URL/,
    );
    expect(() => catalogPathNextTo('/_next/static/media/risk-catalog.abc.yaml')).toThrow(
      /is not a URL/,
    );
  });
});
