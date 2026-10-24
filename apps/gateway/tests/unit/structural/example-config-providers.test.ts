/**
 * Structural test: the deployment examples (`deploy/config/gateway.example.yaml`,
 * `deploy/config/.env.example`) show no OAuth client declared per provider.
 *
 * The `providers.<id>.<field>` keys and the `VAUBAAN_PROVIDER_<ID>_<FIELD>`
 * variables are retired (ADR gmail-over-imap-with-an-app-password): the loader no
 * longer reads them and the root warns when they are set. An example is a
 * promise whether or not it is active, so commented lines are read too.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RETIRED_PROVIDER_ENV_PREFIX, RETIRED_PROVIDERS_KEY } from '../../../src/server/config';

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/config');

/** The lines of an example that set a retired key, commented out or not. */
function retiredLines(source: string): string[] {
  const block = new RegExp(`^(# ?)?${RETIRED_PROVIDERS_KEY}:`);
  const variable = new RegExp(`^#?\\s*${RETIRED_PROVIDER_ENV_PREFIX}[A-Z0-9_]*=`);
  return source.split('\n').filter((line) => block.test(line) || variable.test(line));
}

describe('the deployment examples declare no OAuth client per provider', () => {
  it.each(['gateway.example.yaml', '.env.example'])('%s', (name) => {
    expect(retiredLines(readFileSync(resolve(CONFIG_DIR, name), 'utf8'))).toEqual([]);
  });

  it('the check reads commented and active lines alike', () => {
    expect(
      retiredLines(
        [
          '# providers:',
          'providers:',
          '# VAUBAAN_PROVIDER_GMAIL_CLIENT_ID=x',
          'VAUBAAN_PROVIDER_ACME_CLIENT_SECRET_FILE=/run/secrets/x',
          'sign_in:',
          '# VAUBAAN_SIGN_IN_ACME_CLIENT_ID=x',
        ].join('\n'),
      ),
    ).toHaveLength(4);
  });
});
