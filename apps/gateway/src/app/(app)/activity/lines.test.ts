/**
 * How many lines the Activity page shows: whole pages, one page by default,
 * never more than the ceiling of one address.
 */
import { describe, expect, it } from 'vitest';

import { linesValue, MAX_PAGES, moreLines, parseLines } from './lines';

const PAGE = 50;
const MAX = PAGE * MAX_PAGES;

describe('parseLines', () => {
  it('is one page when absent or unreadable', () => {
    expect(parseLines(null, PAGE)).toBe(PAGE);
    expect(parseLines('', PAGE)).toBe(PAGE);
    expect(parseLines('abc', PAGE)).toBe(PAGE);
    expect(parseLines('-100', PAGE)).toBe(PAGE);
    expect(parseLines('1e3', PAGE)).toBe(PAGE);
    expect(parseLines('100.5', PAGE)).toBe(PAGE);
    expect(parseLines('0', PAGE)).toBe(PAGE);
  });

  it('reads whole pages, rounding a partial page up', () => {
    expect(parseLines('50', PAGE)).toBe(50);
    expect(parseLines('100', PAGE)).toBe(100);
    expect(parseLines('101', PAGE)).toBe(150);
    expect(parseLines('1', PAGE)).toBe(50);
  });

  it('is held at the ceiling', () => {
    expect(parseLines(String(MAX), PAGE)).toBe(MAX);
    expect(parseLines(String(MAX + 1), PAGE)).toBe(MAX);
    expect(parseLines('999999', PAGE)).toBe(MAX);
    expect(parseLines('99999999999', PAGE)).toBe(PAGE);
  });
});

describe('moreLines', () => {
  it('asks for one page more', () => {
    expect(moreLines(50, PAGE)).toBe(100);
    expect(moreLines(MAX - PAGE, PAGE)).toBe(MAX);
  });

  it('stops at the ceiling', () => {
    expect(moreLines(MAX, PAGE)).toBeNull();
  });
});

describe('linesValue', () => {
  it('leaves the first page out of the address', () => {
    expect(linesValue(50, PAGE)).toBeNull();
    expect(linesValue(100, PAGE)).toBe('100');
  });
});
