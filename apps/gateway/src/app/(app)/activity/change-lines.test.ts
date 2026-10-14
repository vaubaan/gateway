/**
 * A change of the record in words: the account by its name, each permission
 * with its limits, what changed and what it was — and nothing dropped.
 */
import { describe, expect, it } from 'vitest';

import { changeLines, type ChangeNames } from './change-lines';

const NAMES: ChangeNames = {
  ids: {
    'conn-1': 'Acme product repositories',
    'res-1': 'acme-org/app',
    'res-2': 'acme-org/web',
    'user-bob': 'bob@acme-demo.example',
    'group-admins': 'GitHub admins',
  },
  permission: (riskId) =>
    ({ 'github.read-code': 'Read code', 'github.merge-protected': 'Write on main' })[riskId] ??
    null,
};

const words = (lines: ReturnType<typeof changeLines>) =>
  lines.map((line) => `${line.label}: ${line.value}${line.was ? ` (was ${line.was})` : ''}`);

describe('a change in words', () => {
  it('names the account, the resources and each permission with its limits when a mission is created', () => {
    const lines = changeLines(
      null,
      {
        name: 'Review the docs',
        connections: [{ connection_id: 'conn-1', resource_ids: ['res-1', 'res-2'] }],
        policy: [
          {
            risk_id: 'github.read-code',
            quota: 200,
            rate_limit: { max: 60, window_seconds: 60 },
            gate: 'auto',
          },
          {
            risk_id: 'github.merge-protected',
            quota: 5,
            rate_limit: { max: 2, window_seconds: 60 },
            gate: 'approval',
          },
        ],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
        token_prefix: '0gJvC4mI',
      },
      NAMES,
      'mission',
    );
    expect(words(lines)).toEqual([
      'Name: Review the docs',
      'Account: Acme product repositories · acme-org/app, acme-org/web',
      'Permission: Read code · 200 a day · 60 a minute · runs freely',
      'Permission: Write on main · 5 a day · 2 a minute · ask me first',
      'Limits: reset every day',
      'Ends: never',
      'Key: vbn_live_0gJvC4mI_…',
    ]);
    // The id a person may need to quote stays beside the name.
    expect(lines.filter((line) => line.id).map((line) => line.id)).toEqual([
      'github.read-code',
      'github.merge-protected',
    ]);
    // No raw id of an account or a resource is left in the lines.
    expect(JSON.stringify(lines)).not.toMatch(/conn-1|res-1|connection_id|resource_ids|risk_id"/);
  });

  it('says what changed and what it was, and leaves out what did not change', () => {
    expect(
      words(
        changeLines(
          { resource_id: 'res-1', ref: 'acme-org/app', env: null, hidden: false },
          { resource_id: 'res-1', ref: 'acme-org/app', env: 'staging', hidden: false },
          NAMES,
          'resource',
        ),
      ),
    ).toEqual(['Environment: staging (was none)']);
  });

  it('reads a stored status in the words of the object that holds it', () => {
    const stopped = changeLines(
      { status: 'active' },
      { status: 'revoked', tokens_revoked: 3 },
      NAMES,
      'mission',
    );
    expect(words(stopped)).toEqual(['State: stopped (was running)', 'Keys revoked: 3']);
    // Not a mission: the stored word, not "stopped".
    expect(
      words(changeLines({ status: 'active' }, { status: 'revoked' }, NAMES, 'instance-config')),
    ).toEqual(['State: revoked (was active)']);
    expect(words(changeLines(null, { status: 'active' }, NAMES, 'connection'))).toEqual([
      'State: connected',
    ]);
  });

  it('names a person or a team by the name behind their id, and the access by its permissions', () => {
    expect(
      words(
        changeLines(
          null,
          {
            connection_id: 'conn-1',
            target: { kind: 'user', id: 'user-bob' },
            restriction: ['github.read-code', 'github.merge-protected'],
          },
          NAMES,
          'share',
        ),
      ),
    ).toEqual([
      'Account: Acme product repositories',
      'Given to: bob@acme-demo.example',
      'May allow: 2 of its permissions: Read code, Write on main',
    ]);
    expect(
      words(
        changeLines(
          { owner: { kind: 'user', id: 'user-gone' } },
          { owner: { kind: 'group', id: 'group-admins' } },
          NAMES,
          'connection',
        ),
      ),
    ).toEqual(['Owner: GitHub admins (was user-gone)']);
  });

  it('says a teammate by their email once, not by their id too', () => {
    expect(
      words(
        changeLines(
          null,
          { member_user_id: 'user-bob', member_email: 'bob@acme-demo.example' },
          NAMES,
          'mission',
        ),
      ),
    ).toEqual(['Teammate: bob@acme-demo.example']);
  });

  it('prints a key it does not know under its own name rather than dropping it', () => {
    expect(words(changeLines(null, { some_new_fact: 12, nested: { a: 1 } }, NAMES))).toEqual([
      'Some new fact: 12',
      'Nested: {"a":1}',
    ]);
  });

  it('has nothing to say in lines when the record is not an object', () => {
    expect(changeLines(null, null, NAMES)).toEqual([]);
    expect(changeLines('a', 'b', NAMES)).toEqual([]);
    // A removal says what was there.
    expect(words(changeLines({ name: 'Contractors' }, null, NAMES, 'group'))).toEqual([
      'Name: Contractors',
    ]);
  });
});
