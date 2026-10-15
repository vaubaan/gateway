import { describe, expect, it } from 'vitest';

import { withAssumedEnvs } from './mission-service';
import { acmeConnection } from './testing';

describe('withAssumedEnvs', () => {
  it('reads the named resources under the assumed label and leaves the rest as stored', () => {
    const connection = acmeConnection();
    const [first, ...rest] = connection.resources;
    if (!first) throw new Error('fixture has resources');
    const [read] = withAssumedEnvs([connection], new Map([[first.id, 'prod']]));
    expect(read?.resources[0]).toEqual({ ...first, env: 'prod' });
    expect(read?.resources.slice(1)).toEqual(rest);
    // The stored view is not touched.
    expect(connection.resources[0]).toBe(first);
  });

  it('returns the context unchanged when nothing is assumed', () => {
    const context = [acmeConnection()];
    expect(withAssumedEnvs(context, undefined)).toBe(context);
    expect(withAssumedEnvs(context, new Map())).toBe(context);
  });
});
