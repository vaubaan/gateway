/**
 * The master key as the instance can speak of it (ADR
 * master-key-generated-and-handed-over-by-the-instance): where it comes from,
 * whether this instance generated it, and whether an administrator has
 * confirmed keeping a copy. The key itself is handed out by the handlers, to an
 * operator, as the file the configuration reads; it is never stored in the
 * store and never logged.
 *
 * Two keys of `instance_config`, both plain values (timestamps):
 *
 *   master_key.generated_at    written at the first boot that generated the file
 *   master_key.handed_over_at  written when the administrator confirms the download
 */
import type { EncryptionConfig } from '../config';
import { masterKeyFileText } from '../crypto/master-key-file';
import { systemClock, toIso, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';

export const MASTER_KEY_GENERATED_KEY = 'master_key.generated_at';
export const MASTER_KEY_HANDED_OVER_KEY = 'master_key.handed_over_at';
/** The object of the audit entries about the key: `instance-config` / `master-key`. */
export const MASTER_KEY_OBJECT_ID = 'master-key';

export interface MasterKeyState {
  readonly keyVersion: number;
  /** The file the key is read from; `null` when the key is given by value. */
  readonly file: string | null;
  /** When this instance generated the key file; `null` when the operator provided the key. */
  readonly generatedAt: string | null;
  /** When an administrator confirmed keeping a copy; `null` until then. */
  readonly handedOverAt: string | null;
  /** The setup must hand the key over: generated here, not confirmed yet. */
  readonly handoverPending: boolean;
}

export class MasterKeyService {
  constructor(
    private readonly encryption: EncryptionConfig,
    private readonly config: ConfigRepo,
    private readonly clock: Clock = systemClock,
  ) {}

  async state(): Promise<MasterKeyState> {
    const [generatedAt, handedOverAt] = await Promise.all([
      this.config.get(MASTER_KEY_GENERATED_KEY),
      this.config.get(MASTER_KEY_HANDED_OVER_KEY),
    ]);
    return {
      keyVersion: this.encryption.keyVersion,
      file: this.encryption.masterKeyFile,
      generatedAt,
      handedOverAt,
      handoverPending: generatedAt !== null && handedOverAt === null,
    };
  }

  /** Called once by the boot that wrote the file; a later call changes nothing. */
  async recordGenerated(): Promise<string> {
    const existing = await this.config.get(MASTER_KEY_GENERATED_KEY);
    if (existing) return existing;
    const at = toIso(this.clock.now());
    await this.config.set(MASTER_KEY_GENERATED_KEY, at);
    return at;
  }

  /** Idempotent: a second confirmation keeps the first timestamp. */
  async confirmHandover(): Promise<{ readonly handedOverAt: string; readonly already: boolean }> {
    const existing = await this.config.get(MASTER_KEY_HANDED_OVER_KEY);
    if (existing) return { handedOverAt: existing, already: true };
    const handedOverAt = toIso(this.clock.now());
    await this.config.set(MASTER_KEY_HANDED_OVER_KEY, handedOverAt);
    return { handedOverAt, already: false };
  }

  /** The key as its file holds it: what the download hands over. */
  fileText(): string {
    return masterKeyFileText(this.encryption.masterKey);
  }
}
