import { describe, expect, test } from 'vitest';
import { parseSlice, slicePathIssue, validateDataModel } from '@vaubaan/plugin-sdk';

import { githubDataModel } from '../../src/data-model.ts';

const issueOf = (slice: string) =>
  slicePathIssue(githubDataModel, parseSlice(slice), 'slice', { cardinalities: true });

describe('githubDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(githubDataModel)).toEqual([]);
  });

  test('one plane with two roots : the repository, and the global search beyond it', () => {
    expect(githubDataModel.planes.map((p) => p.slug)).toEqual(['repo']);
    const roots = githubDataModel.planes
      .flatMap((p) => p.entities)
      .filter((e) => e.parent === null);
    expect(roots.map((e) => e.name)).toEqual(['repo', 'search']);
  });
});

describe('githubDataModel — the slices it reads', () => {
  test("the search : 'issues' is the search, not a typo of a repository's 'issue'", () => {
    expect(issueOf('github.search.code.R')).toBeNull();
    expect(issueOf('github.search.issues.R')).toBeNull();
  });

  test('a job is named through its run and its workflow, "any" where unknown', () => {
    expect(issueOf('github.repo[a/b].workflow[*].workflow-run[7].job.R')).toBeNull();
    expect(issueOf('github.repo[a/b].workflow[*].workflow-run[*].job[9].log.R')).toBeNull();
    // The shapes before : a run, a job, straight under the repository.
    expect(issueOf('github.repo[a/b].workflow-run[7].job.R')).not.toBeNull();
    expect(issueOf('github.repo[a/b].job[9].log.R')).not.toBeNull();
  });
});
