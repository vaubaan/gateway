/**
 * Structural: a source file stays at or under 800 lines, and a file already over it only
 * shrinks (docs/quality/code-quality.md, rule 1). A file that keeps growing becomes the place
 * every conversation edits at once: `lib/vocabulary.ts` took 45 commits in a month, and
 * `missions/mission-service.ts` regrew to 1771 lines a week after being split.
 *
 * `FILE_SIZE_BASELINE` lists the files over the budget on 2026-11-28 with their line count.
 * The test fails when a file not listed goes over 800, when a listed file grows, and when a
 * listed file shrank without its entry following it (lower the number, or remove the entry
 * once the file is at or under 800): the list only ever gets shorter and its numbers smaller.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const LINE_BUDGET = 800;

/** Over the budget on 2026-11-28; each number may only go down. */
const FILE_SIZE_BASELINE: Readonly<Record<string, number>> = {
  'apps/gateway/src/app/(app)/accounts/[id]/account-view.tsx': 1239,
  'apps/gateway/src/app/(app)/activity/record/page.tsx': 874,
  'apps/gateway/src/app/(app)/missions/new/mission-form.tsx': 942,
  'apps/gateway/src/app/(app)/waiting/request-view.tsx': 1049,
  'apps/gateway/src/lib/missions/mission-edit.ts': 1001,
  'apps/gateway/src/lib/missions/preview.ts': 1247,
  'apps/gateway/src/lib/vocabulary.ts': 2158,
  'apps/gateway/src/server/accounts/service.ts': 1579,
  'apps/gateway/src/server/auth/handlers.ts': 856,
  'apps/gateway/src/server/auth/local-handlers.ts': 839,
  'apps/gateway/src/server/auth/sign-in-providers.ts': 900,
  'apps/gateway/src/server/compose/root.ts': 1448,
  'apps/gateway/src/server/config/load.ts': 1406,
  'apps/gateway/src/server/config/sources.ts': 1063,
  'apps/gateway/src/server/import-v4/importer.ts': 1095,
  'apps/gateway/src/server/missions/mission-service.ts': 1771,
  'apps/gateway/src/server/requests/request-service.ts': 1398,
  'apps/gateway/src/server/store/repositories/audit.ts': 1186,
  'apps/gateway/src/server/store/repositories/mission-logs.ts': 865,
  'apps/gateway/src/server/vaubaan/acts.ts': 843,
  'packages/gateway-core/src/pipeline.ts': 1079,
  'packages/plugin-page/src/ServicePage.tsx': 1261,
  'packages/plugin-page/src/page-data.ts': 836,
  'plugins/github/src/call.ts': 817,
  'plugins/gmail/src/execute.ts': 854,
  'plugins/stripe/src/tools.ts': 825,
  'plugins/supabase/src/classify.ts': 804,
};

/** Source files: tracked, code, not a test, a fixture or a declaration. */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'apps', 'packages', 'plugins', 'scripts'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(
      (f) =>
        /\.(ts|tsx|mjs|js|cjs)$/.test(f) &&
        !/(\.test\.|\.spec\.|\/tests?\/|\/e2e\/|\.d\.ts$|\/fixtures\/)/.test(f),
    );
}

const linesOf = (file: string): number =>
  readFileSync(resolve(REPO, file), 'utf8').split('\n').length - 1;

describe('file size budget', () => {
  const sizes = new Map(sourceFiles().map((file) => [file, linesOf(file)]));

  it(`no source file outside the baseline goes over ${LINE_BUDGET} lines`, () => {
    const over = [...sizes]
      .filter(([file, lines]) => lines > LINE_BUDGET && !(file in FILE_SIZE_BASELINE))
      .map(([file, lines]) => `${file}: ${lines} lines`);
    expect(over, 'split these files (docs/quality/code-quality.md, rule 1)').toEqual([]);
  });

  it('a file of the baseline never grows, and its entry follows it down', () => {
    const drift = Object.entries(FILE_SIZE_BASELINE).flatMap(([file, recorded]) => {
      const lines = sizes.get(file);
      if (lines === undefined) return [`${file}: gone, remove its entry`];
      if (lines > recorded) return [`${file}: ${lines} lines, over its ${recorded}: split it`];
      if (lines <= LINE_BUDGET) return [`${file}: ${lines} lines, within budget: remove its entry`];
      if (lines < recorded) return [`${file}: ${lines} lines, set its entry to ${lines}`];
      return [];
    });
    expect(drift).toEqual([]);
  });
});
