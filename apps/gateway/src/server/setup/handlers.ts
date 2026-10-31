/**
 * `POST /api/setup/master-key` — the setup page hands the instance the key of
 * the copy it is to restore (multipart: `token`, the bootstrap token; `key`,
 * the key file). Origin-checked against `public_url`; the bootstrap token of
 * the configuration is the only credential there is before a store exists,
 * compared in constant time, throttled (`AUTH_LIMITS.bootstrapPerInstance`)
 * and refused for good after `BOOTSTRAP_MAX_MISSES` wrong tokens — a count
 * kept next to the key file, so a restart does not reset it (`misses.ts`).
 *
 * The key must be 32 bytes in base64 (the file the download hands out, or
 * what `gen-master-key` printed). It is written to the configured path
 * (0600, never over an existing file), then `complete()` runs the normal
 * boot: the first-boot restore with every verification, the store opens. A
 * refused boot removes the key file again and says why on the page — the
 * restore's message names the check that failed, never the source. Nothing
 * of the key or of the token reaches a log line or the page.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';

import { BOOTSTRAP_MAX_MISSES } from '../auth/bootstrap';
import { AUTH_LIMITS, notAFormResponse, readForm } from '../auth/handlers';
import { forbiddenOriginResponse, isSameOrigin } from '../auth/origin';
import { errorMessage } from '../config';
import { parseMasterKeyText, writeGeneratedMasterKeyFile } from '../crypto/master-key-file';
import { toIso } from '../store/clock';
import { clearSetup, SETUP_KEY_ACTION, SETUP_PAGE, type SetupState } from './state';

export { SETUP_KEY_ACTION, SETUP_PAGE };

export const TOKEN_FIELD = 'token';
export const KEY_FIELD = 'key';
/** Longest key file accepted: the key is 45 bytes; this leaves room for an editor's noise. */
export const MAX_KEY_FILE_BYTES = 4096;
export const SETUP_ERROR_PARAM = 'error';

export type SetupErrorCode =
  | 'no-bootstrap-token'
  | 'bootstrap-refused'
  | 'too-many-attempts'
  | 'setup-locked'
  | 'key-missing'
  | 'key-invalid'
  | 'key-busy'
  | 'restore-refused';

export const SETUP_ERROR_MESSAGES: Readonly<Record<SetupErrorCode, string>> = {
  'no-bootstrap-token':
    'This gateway has no bootstrap token in its configuration, so nobody can hand it the key here. Set bootstrap_token (VAUBAAN_BOOTSTRAP_TOKEN) and start again.',
  'bootstrap-refused': 'That is not the bootstrap token of the configuration.',
  'too-many-attempts': 'Too many attempts. Wait ten minutes and try again.',
  'setup-locked':
    'The bootstrap token was presented wrongly too many times: the setup accepts no more. Delete the file setup-misses next to the key file on the host, restart the gateway and try again with the right token.',
  'key-missing': 'Choose the key file first.',
  'key-invalid':
    'That file does not hold an encryption key: expected 32 bytes in base64 on one line, as the download of the former instance handed it out.',
  'key-busy': 'A key is being installed right now. Wait a moment and reload this page.',
  'restore-refused':
    'The key was written and removed again: with it, the copy did not pass its checks. The reason is below.',
};

export function isSetupErrorCode(value: unknown): value is SetupErrorCode {
  return typeof value === 'string' && Object.hasOwn(SETUP_ERROR_MESSAGES, value);
}

const SEE_OTHER = 303;

function redirect(location: string): Response {
  return new Response(null, {
    status: SEE_OTHER,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function refused(code: SetupErrorCode): Response {
  return redirect(`${SETUP_PAGE}?${SETUP_ERROR_PARAM}=${code}`);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

type KeyText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large' };

/** The key field: a file (the page) or a text (a client), capped before it is read. */
async function keyTextOf(form: FormData): Promise<KeyText> {
  const value = form.get(KEY_FIELD);
  if (value === null) return { kind: 'missing' };
  if (typeof value === 'string') {
    return value.length > MAX_KEY_FILE_BYTES
      ? { kind: 'too-large' }
      : { kind: 'text', text: value };
  }
  if (value.size === 0) return { kind: 'missing' };
  if (value.size > MAX_KEY_FILE_BYTES) return { kind: 'too-large' };
  return { kind: 'text', text: await value.text() };
}

export interface SetupHandlers {
  receiveKey(request: Request): Promise<Response>;
}

export function createSetupHandlers(state: SetupState): SetupHandlers {
  const { logger } = state;
  return {
    async receiveKey(request) {
      if (!isSameOrigin(request.headers, state.config.publicUrl)) return forbiddenOriginResponse();
      const token = state.config.bootstrapToken;
      if (token === null) return refused('no-bootstrap-token');
      if (state.misses >= BOOTSTRAP_MAX_MISSES) return refused('setup-locked');
      const { limit, windowMs } = AUTH_LIMITS.bootstrapPerInstance;
      const taken = await state.rateLimiter.take('setup:master-key', limit, windowMs);
      if (!taken.allowed) {
        logger.warn('setup: key reception throttled');
        return refused('too-many-attempts');
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const presented = form.get(TOKEN_FIELD);
      if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), digest(token))) {
        state.misses += 1;
        state.missesFile.write(state.misses);
        logger.warn('setup: bootstrap token refused', { misses: state.misses });
        return refused(state.misses >= BOOTSTRAP_MAX_MISSES ? 'setup-locked' : 'bootstrap-refused');
      }
      const key = await keyTextOf(form);
      if (key.kind === 'missing') return refused('key-missing');
      if (key.kind === 'too-large' || parseMasterKeyText(key.text) === null) {
        return refused('key-invalid');
      }
      const text = key.text;

      const path = state.masterKeyFile;
      try {
        // A new host's empty volume: the key file's directory may not exist yet.
        writeGeneratedMasterKeyFile(path, `${text.trim()}\n`);
      } catch (err) {
        logger.warn('setup: the key file could not be written', { path, err: errorMessage(err) });
        return refused('key-busy');
      }
      logger.info('setup: key file received and written; completing the boot', { path });
      try {
        await state.complete();
      } catch (err) {
        const message = errorMessage(err);
        try {
          unlinkSync(path);
        } catch (unlinkErr) {
          logger.error('setup: the refused key file could not be removed', {
            path,
            err: errorMessage(unlinkErr),
          });
        }
        state.lastRefusal = { message, at: toIso(new Date()) };
        // What a refused first boot prints on stderr otherwise: the restore names the
        // check that failed, never the source; nothing else of the boot quotes a value.
        logger.error('setup: the boot refused the received key; the key file was removed', {
          path,
          failure: message,
        });
        return refused('restore-refused');
      }
      // The restored store counts from here (`bootstrap.misses`).
      state.missesFile.remove();
      clearSetup();
      logger.info('setup complete: the store is restored and the gateway serves', { path });
      return redirect(SETUP_PAGE);
    },
  };
}
