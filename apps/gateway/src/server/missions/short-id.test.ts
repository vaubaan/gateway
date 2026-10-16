import { describe, expect, it } from 'vitest';

import { newId } from '../store/ids';
import { shortId } from './short-id';

describe('shortId', () => {
  it('is the last 8 characters of the id', () => {
    expect(shortId('0192f3a4-5b6c-7d8e-9f00-112233445566')).toBe('33445566');
  });

  it('tells apart two ids made in the same millisecond', () => {
    const at = Date.now();
    expect(shortId(newId(at))).not.toBe(shortId(newId(at)));
  });
});
