import { describe, expect, it } from 'vitest';
import { isSqliteVersionAtLeast, MIN_SQLITE_VERSION } from '../../../../src/server/store/db.ts';

describe('isSqliteVersionAtLeast', () => {
  it('compares major, minor and patch in order', () => {
    expect(isSqliteVersionAtLeast('3.37.0', MIN_SQLITE_VERSION)).toBe(true);
    expect(isSqliteVersionAtLeast('3.45.1', MIN_SQLITE_VERSION)).toBe(true);
    expect(isSqliteVersionAtLeast('4.0.0', MIN_SQLITE_VERSION)).toBe(true);
    expect(isSqliteVersionAtLeast('3.36.9', MIN_SQLITE_VERSION)).toBe(false);
    expect(isSqliteVersionAtLeast('2.99.99', MIN_SQLITE_VERSION)).toBe(false);
  });

  it('treats missing or malformed components as zero', () => {
    expect(isSqliteVersionAtLeast('3.37', MIN_SQLITE_VERSION)).toBe(true);
    expect(isSqliteVersionAtLeast('3', MIN_SQLITE_VERSION)).toBe(false);
    expect(isSqliteVersionAtLeast('garbage', MIN_SQLITE_VERSION)).toBe(false);
  });
});
