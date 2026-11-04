import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../server/compose/shipped-plugins';
import { RESOURCE_NOUN_FALLBACK, resourceNounOf } from './resource-noun';

describe('resourceNounOf', () => {
  it("is the plugin's noun when it declares one", () => {
    expect(resourceNounOf({ resourceNoun: { one: 'board', other: 'boards' } })).toEqual({
      one: 'board',
      other: 'boards',
    });
  });

  it('falls back to resource / resources for a plugin without one, or a plugin that is gone', () => {
    expect(resourceNounOf({})).toEqual({ one: 'resource', other: 'resources' });
    expect(resourceNounOf(null)).toBe(RESOURCE_NOUN_FALLBACK);
  });

  it('every shipped plugin names its resources', () => {
    for (const plugin of SHIPPED_PLUGINS) {
      expect(plugin.resourceNoun, plugin.id).toBeDefined();
    }
  });
});
