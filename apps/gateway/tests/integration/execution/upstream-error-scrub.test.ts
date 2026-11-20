/**
 * A service's error text reaches the agent without the account's secret.
 *
 * The `detail` of a failed call is the service's own message: a service that
 * echoes what it was sent would otherwise hand the agent the credential the
 * gateway keeps from it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEPOT_API_KEY,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';
import { SCRUBBED, scrubSecrets } from '../../../src/server/execution/scrub-secrets';

const READ = 'depot.read';
const TOOL = 'depot__read_item';
const ARGS = { space: 'scratch' };

describe("a service's error text", () => {
  let instance: ExecutionInstance;
  let mission: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance();
    mission = await instance.issue({ policy: [line(READ, 5)] });
  });
  afterEach(async () => {
    await instance.close();
  });

  it('reaches the agent with the credential replaced', async () => {
    instance.depot.script(() =>
      Promise.reject(new Error(`401: token ${DEPOT_API_KEY} is not valid for space scratch`)),
    );

    const body = await instance.call(mission, TOOL, ARGS);

    const [content] = (body.result?.content ?? []) as { type: string; text: string }[];
    expect(content?.text).not.toContain(DEPOT_API_KEY);
    expect(content?.text).toContain(`token ${SCRUBBED} is not valid for space scratch`);
    const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
    expect(JSON.stringify(entry)).not.toContain(DEPOT_API_KEY);
  });
});

describe('scrubSecrets', () => {
  it('replaces the longest secret first, and leaves short values alone', () => {
    expect(scrubSecrets('a abcdefgh-ijkl b abcdefgh', ['abcdefgh', 'abcdefgh-ijkl', 'ab'])).toBe(
      `a ${SCRUBBED} b ${SCRUBBED}`,
    );
  });
});
