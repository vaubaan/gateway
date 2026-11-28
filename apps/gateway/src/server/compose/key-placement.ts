/**
 * Whether the master key file lives on the same mount as the store it seals
 * (ADR master-key-generated-and-handed-over-by-the-instance, amendment
 * 2026-10-31; threat model, "The master key").
 *
 * A snapshot of a volume, a platform backup or a stolen disk that holds both
 * the store and its key yields every credential: encryption at rest is then a
 * format. The reference deployment mounts the key on a volume of its own; the
 * boot warns when it is not so, unless the operator said they keep the
 * volume's copies apart (`encryption.accept_key_beside_store`).
 *
 * "The same mount" is read from `/proc/self/mountinfo`: the mount point that
 * holds a path is the longest mount point that is a prefix of it. Two Docker
 * volumes are two mounts even when they sit on one host disk, which a device
 * number alone would not tell. Where the file cannot be read (not Linux), the
 * device numbers decide.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';

/** The facts the check reads; the process's own by default, tests inject theirs. */
export interface MountFacts {
  /** The text of `/proc/self/mountinfo`, or `null` when there is none. */
  readonly mountInfo: () => string | null;
  /** The resolved path of an existing directory, or `null`. */
  readonly realDirectory: (path: string) => string | null;
  /** The device number of an existing path, or `null`. */
  readonly device: (path: string) => number | null;
}

export const PROCESS_MOUNT_FACTS: MountFacts = {
  mountInfo: () => {
    try {
      return readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      // expected: no readable /proc/self/mountinfo (not Linux, or hidden): the mounts are unknown
      return null;
    }
  },
  realDirectory: (path) => {
    try {
      return realpathSync(path);
    } catch {
      // expected: the path does not resolve (missing, unreadable): no real directory
      return null;
    }
  },
  device: (path) => {
    try {
      return statSync(path).dev;
    } catch {
      // expected: the path cannot be stat-ed (missing, unreadable): no device
      return null;
    }
  },
};

/** `\040` and its siblings: how mountinfo escapes a space, a tab, a newline, a backslash. */
function unescapeMountPoint(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/** The mount points of a mountinfo text (its fifth field). */
export function mountPointsOf(mountInfo: string): string[] {
  const points: string[] = [];
  for (const line of mountInfo.split('\n')) {
    const point = line.split(' ')[4];
    if (point) points.push(unescapeMountPoint(point));
  }
  return points;
}

/** The mount point that holds `path`: the longest one that is `path` or a parent of it. */
export function mountPointOf(path: string, points: readonly string[]): string | null {
  let best: string | null = null;
  for (const point of points) {
    const holds = point === '/' || path === point || path.startsWith(point + sep);
    if (holds && (best === null || point.length > best.length)) best = point;
  }
  return best;
}

/**
 * `true` when the key file and the store sit on one mount, `false` when they do
 * not, `null` when it cannot be told (a directory missing, nothing to read).
 */
export function keyBesideStore(
  keyFile: string,
  storePath: string,
  facts: MountFacts = PROCESS_MOUNT_FACTS,
): boolean | null {
  const keyDir = facts.realDirectory(dirname(keyFile));
  const storeDir = facts.realDirectory(dirname(storePath));
  if (keyDir === null || storeDir === null) return null;
  const info = facts.mountInfo();
  if (info !== null) {
    const points = mountPointsOf(info);
    const keyMount = mountPointOf(keyDir, points);
    const storeMount = mountPointOf(storeDir, points);
    if (keyMount !== null && storeMount !== null) return keyMount === storeMount;
  }
  const keyDevice = facts.device(keyDir);
  const storeDevice = facts.device(storeDir);
  if (keyDevice === null || storeDevice === null) return null;
  return keyDevice === storeDevice;
}

/** Said once at boot, naming what makes it go away. */
export const KEY_BESIDE_STORE_WARNING =
  'the master key file is on the same mount as the store: a copy of that volume opens every stored credential';
