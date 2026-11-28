/**
 * The raw configuration tree both sources produce, and the helpers that walk it.
 * A leaf of the config modules: it imports none of them.
 */
export type RawTree = Record<string, unknown>;

export function isPlainObject(value: unknown): value is RawTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function setPath(tree: RawTree, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: RawTree = {};
      node[part] = created;
      node = created;
    }
  }
  node[parts[parts.length - 1] ?? ''] = value;
}

export function getPath(tree: RawTree, path: string): unknown {
  let node: unknown = tree;
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    // nosemgrep: prototype-pollution-loop -- read-only walk of the operator's configuration tree; nothing is assigned
    node = node[part];
  }
  return node;
}

/** Deep merge where `over` wins on every leaf; objects merge key by key. */
export function mergeTrees(base: RawTree, over: RawTree): RawTree {
  const out: RawTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeTrees(existing, value) : value;
  }
  return out;
}

export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return undefined;
}
