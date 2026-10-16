/**
 * The instance's own resources (`readSelfResources`): the platform's, which
 * the configuration cannot remove, then the configured ones, without
 * duplicates. ADR self-resources-never-reachable-by-a-mission (amendment of
 * 2026-10-16: an instance on Fly counts its own app).
 */
import { describe, expect, it } from 'vitest';

import {
  FLY_APP_ENV,
  RAILWAY_PROJECT_ENV,
  isSelfResource,
  readSelfResources,
} from '../../../../src/server/config/self-resources';

const noIssue = (message: string): never => {
  throw new Error(message);
};

describe('readSelfResources', () => {
  it('an instance on Fly counts its own app, from FLY_APP_NAME', () => {
    expect(readSelfResources([], { [FLY_APP_ENV]: 'vaubaan-dogfood' }, noIssue)).toEqual([
      { provider: 'fly', ref: 'vaubaan-dogfood', source: 'fly' },
    ]);
  });

  it('an instance on Railway counts its project; both platforms are kept when both are set', () => {
    expect(
      readSelfResources([], { [RAILWAY_PROJECT_ENV]: 'p-1', [FLY_APP_ENV]: ' gw ' }, noIssue),
    ).toEqual([
      { provider: 'railway', ref: 'p-1', source: 'railway' },
      { provider: 'fly', ref: 'gw', source: 'fly' },
    ]);
  });

  it('a configured entry naming the platform app is not added twice', () => {
    const selves = readSelfResources(
      ['fly:gw', 'fly:control-plane'],
      { [FLY_APP_ENV]: 'gw' },
      noIssue,
    );
    expect(selves).toEqual([
      { provider: 'fly', ref: 'gw', source: 'fly' },
      { provider: 'fly', ref: 'control-plane', source: 'config' },
    ]);
    expect(isSelfResource(selves, 'fly', 'control-plane')).toBe(true);
    expect(isSelfResource(selves, 'fly', 'tenant-acme')).toBe(false);
  });

  it('an empty FLY_APP_NAME adds nothing; a malformed entry is reported', () => {
    const issues: string[] = [];
    expect(
      readSelfResources(['nope'], { [FLY_APP_ENV]: '  ' }, (m) => {
        issues.push(m);
      }),
    ).toEqual([]);
    expect(issues).toHaveLength(1);
  });
});
