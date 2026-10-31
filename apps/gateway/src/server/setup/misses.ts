/**
 * The wrong bootstrap tokens presented in setup mode, kept on disk next to the
 * key file (`<key directory>/setup-misses`), so a restart does not reset them
 * (security audit 2026-10-31, L5). In setup mode there is no store yet: the
 * normal path's durable counter (`bootstrap.misses` in `instance_config`) has
 * nowhere to live, and the key directory is the one place the instance writes
 * to before the store exists.
 *
 * The file holds a whole number and nothing else (mode 0600). It is removed once
 * the setup completes: the restored store's own counter takes over. A file that
 * cannot be read as a number counts as the limit (locked): it fails closed, and
 * the page says to restart with the right token, which deleting the file allows.
 * A file that cannot be written is logged; the count still holds for the process.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BOOTSTRAP_MAX_MISSES } from '../auth/bootstrap';
import { errorMessage } from '../config';
import type { Logger } from '../logging';

export const SETUP_MISSES_FILE_NAME = 'setup-misses';

export interface SetupMissesFile {
  /** Where the count is kept (a path, never a secret). */
  readonly path: string;
  /** The count so far: 0 without a file, the limit for a file that holds no count. */
  read(): number;
  write(misses: number): void;
  /** Once the setup completed. */
  remove(): void;
}

export function setupMissesFile(
  masterKeyFile: string,
  logger: Pick<Logger, 'warn'>,
): SetupMissesFile {
  const path = join(dirname(masterKeyFile), SETUP_MISSES_FILE_NAME);
  return {
    path,
    read() {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        logger.warn('setup: the count of wrong tokens could not be read; locked', {
          path,
          err: errorMessage(err),
        });
        return BOOTSTRAP_MAX_MISSES;
      }
      const trimmed = text.trim();
      if (!/^\d{1,6}$/.test(trimmed)) {
        logger.warn('setup: the count of wrong tokens is not a number; locked', { path });
        return BOOTSTRAP_MAX_MISSES;
      }
      return Number(trimmed);
    },
    write(misses) {
      try {
        // An empty volume may not have the key's directory yet.
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${misses}\n`, { mode: 0o600 });
      } catch (err) {
        logger.warn('setup: the count of wrong tokens could not be kept on disk', {
          path,
          err: errorMessage(err),
        });
      }
    },
    remove() {
      rmSync(path, { force: true });
    },
  };
}
