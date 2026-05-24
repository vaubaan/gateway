'use client';

import { useState } from 'react';

export type Operator =
  | 'equals'
  | 'in'
  | 'not_in'
  | 'match'
  | 'regex'
  | 'starts_with'
  | 'not_starts_with';

export interface EditableConstraint {
  path: string;
  operator: Operator;
  value: string;
}

export interface EditableRule {
  effect: 'allow' | 'deny';
  toolKind: 'exact' | 'glob';
  tool?: string;
  tool_matches?: string[];
  target: 'project.repos' | 'project.vercel' | 'project.supabase' | '*';
  constraints: EditableConstraint[];
  priority?: number | null;
}

export function defaultEmptyRule(): EditableRule {
  return {
    effect: 'allow',
    toolKind: 'glob',
    tool_matches: [],
    target: '*',
    constraints: [],
    priority: null,
  };
}

export function ruleFromStored(r: Record<string, unknown>): EditableRule {
  const c = (r.constraints ?? {}) as Record<string, Record<string, unknown>>;
  const constraints: EditableConstraint[] = [];
  for (const [path, op] of Object.entries(c)) {
    if ('equals' in op) constraints.push({ path, operator: 'equals', value: String(op.equals) });
    else if ('in' in op)
      constraints.push({ path, operator: 'in', value: (op.in as unknown[]).join(',') });
    else if ('not_in' in op)
      constraints.push({ path, operator: 'not_in', value: (op.not_in as unknown[]).join(',') });
    else if ('match' in op)
      constraints.push({ path, operator: 'match', value: (op.match as unknown[]).join(',') });
    else if ('regex' in op) constraints.push({ path, operator: 'regex', value: String(op.regex) });
    else if ('starts_with' in op)
      constraints.push({
        path,
        operator: 'starts_with',
        value: Array.isArray(op.starts_with) ? op.starts_with.join(',') : String(op.starts_with),
      });
    else if ('not_starts_with' in op)
      constraints.push({
        path,
        operator: 'not_starts_with',
        value: Array.isArray(op.not_starts_with)
          ? op.not_starts_with.join(',')
          : String(op.not_starts_with),
      });
  }
  const tool_matches = Array.isArray(r.tool_matches) ? (r.tool_matches as string[]) : undefined;
  return {
    effect: (r.effect as 'allow' | 'deny') ?? 'allow',
    toolKind: r.tool ? 'exact' : 'glob',
    tool: (r.tool as string | undefined) ?? undefined,
    tool_matches: tool_matches ?? [],
    target: (r.target as EditableRule['target']) ?? '*',
    constraints,
    priority: (r.priority as number | undefined) ?? null,
  };
}

export function RuleEditor({
  rule,
  onChange,
  onDelete,
  onMove,
}: {
  rule: EditableRule;
  onChange: (next: EditableRule) => void;
  onDelete?: () => void;
  onMove?: (direction: 'up' | 'down') => void;
}) {
  const isAllow = rule.effect === 'allow';
  const [globText, setGlobText] = useState((rule.tool_matches ?? []).join('\n'));

  function commitGlobs(text: string) {
    setGlobText(text);
    onChange({
      ...rule,
      tool_matches: text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }

  return (
    <div
      style={{
        padding: 12,
        marginBottom: 10,
        border: '1px solid #2a2a2a',
        borderLeft: `3px solid ${isAllow ? '#7ee87e' : '#ff7e7e'}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <select
          value={rule.effect}
          onChange={(e) => onChange({ ...rule, effect: e.target.value as 'allow' | 'deny' })}
          style={inlineField}
        >
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
        <select
          value={rule.target}
          onChange={(e) => onChange({ ...rule, target: e.target.value as EditableRule['target'] })}
          style={inlineField}
        >
          <option value="*">target: *</option>
          <option value="project.repos">target: project.repos</option>
          <option value="project.vercel">target: project.vercel</option>
          <option value="project.supabase">target: project.supabase</option>
        </select>
        <select
          value={rule.toolKind}
          onChange={(e) => onChange({ ...rule, toolKind: e.target.value as 'exact' | 'glob' })}
          style={inlineField}
        >
          <option value="glob">tool_matches</option>
          <option value="exact">exact tool</option>
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {onMove && (
            <>
              <button type="button" onClick={() => onMove('up')} style={iconBtn} title="Move up">
                ↑
              </button>
              <button
                type="button"
                onClick={() => onMove('down')}
                style={iconBtn}
                title="Move down"
              >
                ↓
              </button>
            </>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              style={{ ...iconBtn, color: '#ff7e7e' }}
              title="Remove rule"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {rule.toolKind === 'exact' ? (
        <input
          value={rule.tool ?? ''}
          onChange={(e) => onChange({ ...rule, tool: e.target.value })}
          placeholder="e.g. github__create_pull_request"
          style={blockField}
        />
      ) : (
        <textarea
          value={globText}
          onChange={(e) => commitGlobs(e.target.value)}
          rows={Math.max(2, (globText.match(/\n/g) ?? []).length + 1)}
          placeholder="one per line — e.g. github__list_*"
          style={{ ...blockField, fontFamily: 'monospace' }}
        />
      )}

      <div style={{ marginTop: 10 }}>
        <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 4 }}>Constraints</div>
        {rule.constraints.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input
              value={c.path}
              onChange={(e) =>
                onChange({
                  ...rule,
                  constraints: rule.constraints.map((x, j) =>
                    j === i ? { ...x, path: e.target.value } : x,
                  ),
                })
              }
              placeholder="arguments.branch"
              style={{ ...inlineField, minWidth: 200 }}
            />
            <select
              value={c.operator}
              onChange={(e) =>
                onChange({
                  ...rule,
                  constraints: rule.constraints.map((x, j) =>
                    j === i ? { ...x, operator: e.target.value as Operator } : x,
                  ),
                })
              }
              style={inlineField}
            >
              <option value="equals">equals</option>
              <option value="in">in</option>
              <option value="not_in">not_in</option>
              <option value="match">match (glob)</option>
              <option value="regex">regex</option>
              <option value="starts_with">starts_with</option>
              <option value="not_starts_with">not_starts_with</option>
            </select>
            <input
              value={c.value}
              onChange={(e) =>
                onChange({
                  ...rule,
                  constraints: rule.constraints.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x,
                  ),
                })
              }
              placeholder={
                ['in', 'not_in', 'match', 'starts_with', 'not_starts_with'].includes(c.operator)
                  ? 'comma-separated'
                  : 'value'
              }
              style={{ ...inlineField, flex: 1 }}
            />
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...rule,
                  constraints: rule.constraints.filter((_, j) => j !== i),
                })
              }
              style={{ ...iconBtn, color: '#ff7e7e' }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({
              ...rule,
              constraints: [
                ...rule.constraints,
                { path: 'arguments.', operator: 'equals', value: '' },
              ],
            })
          }
          style={{ ...inlineField, cursor: 'pointer', marginTop: 4 }}
        >
          + Add constraint
        </button>
      </div>
    </div>
  );
}

const inlineField: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 4,
  background: '#0c0c0c',
  color: '#fff',
  border: '1px solid #2a2a2a',
  fontSize: 13,
};
const blockField: React.CSSProperties = {
  width: '100%',
  padding: 8,
  borderRadius: 4,
  background: '#0c0c0c',
  color: '#fff',
  border: '1px solid #2a2a2a',
  fontSize: 13,
};
const iconBtn: React.CSSProperties = {
  padding: '4px 8px',
  background: 'transparent',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  cursor: 'pointer',
};
