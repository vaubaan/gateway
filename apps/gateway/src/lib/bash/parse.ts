/**
 * Parser for annotated bash scripts attached to bash-provider bindings.
 *
 * Each binding has its own script ; the binding's `host_slug` is the env
 * dimension of the resulting capabilities. The capability surface produced
 * by a binding is :
 *
 *   bash:<ring>:<action>@<host_slug>
 *
 * Annotations are line comments at the top of the file (script-level) and
 * directly above each tool function (function-level) :
 *
 *   # @vaubaan-plane: host             (optional, default 'host')
 *   # @vaubaan-rings: process binary logs
 *
 *   # @vaubaan: ring=process action=read
 *   # @vaubaan-doc: systemctl status of the runner daemon.
 *   runner_status() { ... }
 *
 *   # @vaubaan: ring=binary action=write
 *   # @vaubaan-doc: Replace the binary with a specific version, then restart.
 *   # @vaubaan-arg: version string required
 *   runner_update() { ... }
 *
 * Function-level annotations apply to the next `xxx() {` line below them.
 * Functions without `# @vaubaan: ring=X action=Y` are ignored (treated as
 * private helpers).
 */

export interface ParsedArg {
  name: string;
  type: 'string' | 'integer';
  required: boolean;
  defaultValue?: string;
}

export interface ParsedTool {
  /** Bash function name. */
  functionName: string;
  /** Capability ring slug from `# @vaubaan: ring=…`. */
  ring: string;
  /** R/W from `# @vaubaan: action=…`. */
  action: 'read' | 'write';
  /** Human-readable description from `# @vaubaan-doc:`. */
  doc?: string;
  /** Tool args parsed from `# @vaubaan-arg:`. */
  args: ParsedArg[];
}

export interface ParsedScript {
  /** Plane slug from `# @vaubaan-plane:`. Defaults to `host`. */
  plane: string;
  /** Ordered ring slugs from `# @vaubaan-rings:`. ring 1 = first, ring N = last. */
  rings: string[];
  /** One entry per annotated function. */
  tools: ParsedTool[];
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Parse an annotated bash file. Throws ParseError on structural problems. */
export function parseAnnotatedBash(content: string): ParsedScript {
  const lines = content.split('\n');
  let plane = 'host';
  let rings: string[] = [];
  const tools: ParsedTool[] = [];

  interface Pending {
    ring?: string;
    action?: 'read' | 'write';
    doc?: string;
    args: ParsedArg[];
  }
  let pending: Pending | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();

    // ── Script-level annotations
    const svcPlane = match(line, '@vaubaan-plane:');
    if (svcPlane !== null) {
      plane = svcPlane.trim();
      continue;
    }
    const svcRings = match(line, '@vaubaan-rings:');
    if (svcRings !== null) {
      rings = svcRings.trim().split(/\s+/).filter(Boolean);
      continue;
    }

    // ── Function-level annotations
    const fnAnn = match(line, '@vaubaan:');
    if (fnAnn !== null) {
      const next: Pending = pending ?? { args: [] };
      for (const kv of fnAnn.trim().split(/\s+/)) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (k === 'ring') next.ring = v;
        else if (k === 'action') {
          if (v !== 'read' && v !== 'write') {
            throw new ParseError(`line ${i + 1}: action must be 'read' or 'write', got '${v}'`);
          }
          next.action = v;
        }
      }
      pending = next;
      continue;
    }
    const doc = match(line, '@vaubaan-doc:');
    if (doc !== null) {
      pending = pending ?? { args: [] };
      pending.doc = doc.trim();
      continue;
    }
    const arg = match(line, '@vaubaan-arg:');
    if (arg !== null) {
      pending = pending ?? { args: [] };
      const parts = arg.trim().split(/\s+/);
      const name = parts[0];
      if (!name) {
        throw new ParseError(`line ${i + 1}: @vaubaan-arg requires a name`);
      }
      const type: 'string' | 'integer' = parts[1] === 'integer' ? 'integer' : 'string';
      let required = true;
      let defaultValue: string | undefined;
      for (const p of parts.slice(2)) {
        if (p === 'required') required = true;
        else if (p === 'optional') required = false;
        else if (p.startsWith('default=')) defaultValue = p.slice('default='.length);
      }
      const parsedArg: ParsedArg = { name, type, required };
      if (defaultValue !== undefined) parsedArg.defaultValue = defaultValue;
      pending.args.push(parsedArg);
      continue;
    }

    // ── Function declaration : `name()` (optionally with `{`)
    const fnMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{?/);
    if (fnMatch && pending && pending.ring && pending.action) {
      tools.push({
        functionName: fnMatch[1]!,
        ring: pending.ring,
        action: pending.action,
        ...(pending.doc ? { doc: pending.doc } : {}),
        args: pending.args,
      });
      pending = null;
      continue;
    }
    if (fnMatch) {
      // A function without complete @vaubaan annotation — drop the pending
      // state and skip (it's a private helper).
      pending = null;
      continue;
    }
  }

  // ── Structural validation
  if (rings.length === 0) {
    throw new ParseError('missing `# @vaubaan-rings:` declaration');
  }
  for (const t of tools) {
    if (!rings.includes(t.ring)) {
      throw new ParseError(
        `tool '${t.functionName}' references ring '${t.ring}' but it isn't in @vaubaan-rings`,
      );
    }
  }
  if (tools.length === 0) {
    throw new ParseError('no annotated tool functions found in the file');
  }

  return { plane, rings, tools };
}

function match(line: string, marker: string): string | null {
  const re = new RegExp(`^#\\s*${marker.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*(.*)$`);
  const m = re.exec(line);
  return m ? (m[1] ?? '') : null;
}

/** Pretty-print the parsed script for debugging / UI preview. */
export function summarize(svc: ParsedScript): string {
  const ringLines = svc.rings
    .map((r, i) => {
      const ts = svc.tools.filter((t) => t.ring === r);
      const ops = ts.map((t) => `${t.action[0]?.toUpperCase()}=${t.functionName}`).join(', ');
      return `  ring ${i + 1} ${r} — ${ops || '(no tools)'}`;
    })
    .join('\n');
  return `plane=${svc.plane}\n${ringLines}`;
}
