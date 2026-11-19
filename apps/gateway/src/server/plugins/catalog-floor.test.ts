/** The versions feed never takes a plugin below the version this release knows. */
import { describe, expect, it } from 'vitest';

import { catalogVersionFloor } from './catalog-floor';

describe('the catalog version offered', () => {
  it('follows the feed upward, never below the known version', () => {
    expect(catalogVersionFloor('4.3.0', { version: '4.2.1' })).toBe('4.3.0');
    expect(catalogVersionFloor('4.2.1', { version: '4.2.1' })).toBe('4.2.1');
    expect(catalogVersionFloor('4.0.0', { version: '4.2.1' })).toBe('4.2.1');
    expect(catalogVersionFloor('4.2.1-rc.1', { version: '4.2.1' })).toBe('4.2.1');
  });

  it('falls back on what is known when the feed is silent or malformed', () => {
    expect(catalogVersionFloor(undefined, { version: '1.0.0' })).toBe('1.0.0');
    expect(catalogVersionFloor('latest', { version: '1.0.0' })).toBe('1.0.0');
    expect(catalogVersionFloor('0.3.0', undefined)).toBe('0.3.0');
    expect(catalogVersionFloor(undefined, undefined)).toBeNull();
  });
});
