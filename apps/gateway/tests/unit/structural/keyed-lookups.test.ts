/**
 * Structural: a mission token, a share and a request's held arguments are read
 * and changed only with their parent (security audit 2026-10-31, L8).
 *
 * Every service checks ownership before it touches one of them, and a check
 * forgotten once would be an IDOR. The repositories therefore take a key that
 * carries the parent — `(missionId, tokenId)`, `(accountId, shareId)`,
 * `(missionId, requestId)` — and offer no bare-id variant: a lookup by id
 * alone does not compile (the type assertions below run in `tsc`), and the
 * source of the three repositories holds no statement that selects or updates
 * one of these rows by `id = ?` alone outside their own internal reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  MissionsRepo,
  MissionTokenKey,
} from '../../../src/server/store/repositories/missions';
import type { RequestKey, RequestsRepo } from '../../../src/server/store/repositories/requests';
import type { ShareKey, SharesRepo } from '../../../src/server/store/repositories/shares';

const REPOSITORIES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/server/store/repositories',
);

describe('lookups keyed by their parent', () => {
  it('a token, a share and held arguments take a key with their parent, never an id alone', () => {
    expectTypeOf<Parameters<MissionsRepo['getToken']>[0]>().toEqualTypeOf<MissionTokenKey>();
    expectTypeOf<Parameters<MissionsRepo['revokeToken']>[0]>().toEqualTypeOf<MissionTokenKey>();
    expectTypeOf<Parameters<MissionsRepo['markTokenUsed']>[0]>().toEqualTypeOf<MissionTokenKey>();
    expectTypeOf<Parameters<SharesRepo['get']>[0]>().toEqualTypeOf<ShareKey>();
    expectTypeOf<Parameters<SharesRepo['revoke']>[0]>().toEqualTypeOf<ShareKey>();
    expectTypeOf<Parameters<RequestsRepo['getArguments']>[0]>().toEqualTypeOf<RequestKey>();
    expectTypeOf<SharesRepo>().not.toHaveProperty('getById');
    // `string` is not a key: a bare id does not compile.
    expectTypeOf<string>().not.toExtend<MissionTokenKey>();
    expectTypeOf<string>().not.toExtend<ShareKey>();
    expectTypeOf<string>().not.toExtend<RequestKey>();
  });

  it('the repositories name the parent in every statement that reads or changes one by its id', () => {
    const source = (file: string) => readFileSync(resolve(REPOSITORIES, file), 'utf8');
    const statements: Record<string, readonly RegExp[]> = {
      'missions/holders.ts': [
        /SELECT \$\{TOKEN_COLUMNS\} FROM mission_tokens WHERE mission_id = \? AND id = \?/,
        /UPDATE mission_tokens SET status = 'revoked', retired_at = \?\s+WHERE mission_id = \? AND id = \? AND status = 'active'/,
        /UPDATE mission_tokens SET last_used_at = \?\s+WHERE mission_id = \? AND id = \?/,
      ],
      'shares.ts': [
        /FROM shares WHERE account_id = \? AND id = \?/,
        /UPDATE shares SET status = 'revoked', revoked_at = \?\s+WHERE account_id = \? AND id = \? AND status = 'active'/,
      ],
      'requests.ts': [/FROM requests WHERE mission_id = \? AND id = \?/],
    };
    for (const [file, expected] of Object.entries(statements)) {
      const text = source(file);
      for (const statement of expected) expect(text, file).toMatch(statement);
    }
  });
});
