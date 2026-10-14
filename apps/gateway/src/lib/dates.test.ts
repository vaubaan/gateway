/**
 * The one form the interface writes dates in, and that nothing else writes
 * one: no page hands an instant to the browser's locale.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatClock, formatDay, formatDayTime, formatToday } from './dates';

const AT = '2026-10-14T01:48:59.000Z';
const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('the form of a date', () => {
  it('writes a day as "14 Oct", with the year when it is not this one', () => {
    expect(formatDay(AT, { now: NOW })).toBe('14 Oct');
    expect(formatDay('2025-03-02T10:00:00.000Z', { now: NOW })).toBe('2 Mar 2025');
    expect(formatDay(new Date(AT), { now: NOW })).toBe('14 Oct');
  });

  it('writes the clock on 24 hours, with seconds where a record is read down a column', () => {
    expect(formatClock(AT)).toBe('01:48');
    expect(formatClock(AT, { seconds: true })).toBe('01:48:59');
    expect(formatClock('2026-10-14T13:05:09.000Z', { seconds: true })).toBe('13:05:09');
  });

  it('writes a day and its clock as "14 Oct, 01:48"', () => {
    expect(formatDayTime(AT, { now: NOW })).toBe('14 Oct, 01:48');
    expect(formatDayTime(AT, { now: NOW, seconds: true })).toBe('14 Oct, 01:48:59');
  });

  it('says the date of a page once, in full', () => {
    expect(formatToday(AT)).toBe('Wednesday 14 October, 01:48');
  });

  it('never writes the US form, whatever the locale of the process', () => {
    for (const text of [
      formatDay(AT, { now: NOW }),
      formatDayTime(AT, { now: NOW, seconds: true }),
      formatToday(AT),
      formatDayTime(AT, { now: NOW, zone: 'local' }),
    ]) {
      expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
      expect(text).not.toMatch(/\b[AP]M\b/);
    }
  });

  it('reads the reader’s zone only when asked: the server writes UTC', () => {
    // `local` uses the zone of the process; both forms are the same text shape.
    expect(formatDayTime(AT, { now: NOW, zone: 'local' })).toMatch(
      /^\d{1,2} [A-Z][a-z]{2}, \d\d:\d\d$/,
    );
    expect(formatClock(AT, { zone: 'utc' })).toBe('01:48');
  });

  it('gives an empty text for what is not an instant', () => {
    expect(formatDay('not a date')).toBe('');
    expect(formatClock('not a date')).toBe('');
    expect(formatDayTime('not a date')).toBe('');
    expect(formatToday('not a date')).toBe('');
  });
});

describe('the pages', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('hand no date to the locale of the browser: every date goes through lib/dates', () => {
    const offenders: string[] = [];
    for (const path of [
      ...files(join(SRC, 'app')),
      ...files(join(SRC, 'components')),
      ...files(join(SRC, 'lib')),
    ]) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*|^\s*\/\*/.test(line)) return;
        if (/\.toLocale(Date|Time)String\(/.test(code) || /\bIntl\.DateTimeFormat\b/.test(code)) {
          offenders.push(`${relative(SRC, path)}:${index + 1}`);
        }
        // `toLocaleString` is a number's only: with an explicit locale (`formatNumber`).
        if (/\.toLocaleString\(\s*\)/.test(code))
          offenders.push(`${relative(SRC, path)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
