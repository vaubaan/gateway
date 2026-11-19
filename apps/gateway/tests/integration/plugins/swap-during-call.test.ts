/**
 * A swap of a plugin's version never falls inside a call (ADR
 * plugins-activated-by-an-administrator-on-trial, amendment 2026-11-19): the execution door
 * holds the call's service from its first stage to what follows it, so a call already running
 * finishes on the version it started with, and the swap waits for it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const READ = 'depot.read';
const TOOL = 'depot__read_item';

describe('a swap of a plugin during a call of its service', () => {
  let instance: ExecutionInstance;
  let mission: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance();
    mission = await instance.issue({ policy: [line(READ, 5)] });
  });
  afterEach(async () => {
    await instance.close();
  });

  it('lets a call already running finish on the previous version: the swap waits for it', async () => {
    let release: () => void = () => undefined;
    const upstream = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    instance.depot.script(async () => {
      entered();
      await upstream;
      return { content: [{ type: 'text', text: 'done' }] };
    });

    const call = instance.call(mission, TOOL, { space: 'scratch' });
    await reached;
    const calls = instance.root.pluginInstall.calls;
    expect(calls.running('depot')).toBe(1);

    let swapped = false;
    const swap = calls.swap('depot', () => {
      swapped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(swapped).toBe(false);

    release();
    await call;
    await swap;
    expect(swapped).toBe(true);
    expect(calls.running('depot')).toBe(0);
  });
});
