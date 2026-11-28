import { describe, expect, it } from 'vitest';

import { areaOf, coverageByArea, renderReport, slowestFiles } from './test-report.mjs';

const ROOT = '/repo';
const lines = (total, covered) => ({ lines: { total, covered, pct: (100 * covered) / total } });
const SUMMARY = {
  total: lines(300, 150),
  '/repo/apps/gateway/src/server/store/db.ts': lines(100, 90),
  '/repo/apps/gateway/src/server/store/ids.ts': lines(100, 50),
  '/repo/apps/gateway/src/app/page.tsx': lines(50, 0),
  '/repo/plugins/github/src/call.ts': lines(50, 10),
};
const RESULTS = {
  testResults: [
    { name: '/repo/a.test.ts', startTime: 0, endTime: 1200 },
    { name: '/repo/b.test.ts', startTime: 0, endTime: 9000 },
  ],
};

describe('the weekly test report', () => {
  it('counts a file in its area: a gateway server module, a gateway folder, a package, all plugins', () => {
    expect(areaOf('apps/gateway/src/server/store/db.ts')).toBe('apps/gateway/src/server/store');
    expect(areaOf('apps/gateway/src/app/(app)/page.tsx')).toBe('apps/gateway/src/app');
    expect(areaOf('packages/plugin-sdk/src/index.ts')).toBe('packages/plugin-sdk');
    expect(areaOf('plugins/github/src/call.ts')).toBe('plugins');
  });

  it('sums the lines per area, the least covered first', () => {
    expect(coverageByArea(SUMMARY, ROOT).map((a) => [a.area, a.covered, a.total])).toEqual([
      ['apps/gateway/src/app', 0, 50],
      ['plugins', 10, 50],
      ['apps/gateway/src/server/store', 140, 200],
    ]);
  });

  it('lists the slowest test files first, relative to the repository', () => {
    expect(slowestFiles(RESULTS, ROOT)).toEqual([
      { file: 'b.test.ts', ms: 9000 },
      { file: 'a.test.ts', ms: 1200 },
    ]);
  });

  it('renders Markdown with the total and no threshold', () => {
    const text = renderReport(SUMMARY, RESULTS, ROOT);
    expect(text).toContain('Lines covered: **50.0 %** (150 of 300)');
    expect(text).toContain('| apps/gateway/src/app | 50 | 0.0 % |');
    expect(text).toContain('| b.test.ts | 9.0 |');
  });
});
