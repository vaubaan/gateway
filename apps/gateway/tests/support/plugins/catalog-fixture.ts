/**
 * The catalog versions a test release knows (`buildRoot`'s `knownCatalogVersions`): the
 * shipped `catalog-versions.json`, with notion pinned at the archive of
 * `tests/fixtures/sigstore/notion-v0.2.0.tgz`. A release moves the shipped pins to the
 * catalog's latest; the tests that install notion from that fixture keep their own pin.
 */
import {
  KNOWN_CATALOG_VERSIONS,
  type KnownCatalogVersion,
} from '../../../src/server/plugins/catalog';

export const WITH_NOTION_FIXTURE: ReadonlyMap<string, KnownCatalogVersion> = new Map([
  ...KNOWN_CATALOG_VERSIONS,
  [
    'notion',
    {
      name: 'Notion',
      version: '0.2.0',
      sha256: 'e409fc4629fc79d2826ccc886b78671fb24e35868bc9a5692a009562eeb62f64',
    },
  ],
]);
