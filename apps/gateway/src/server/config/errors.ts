/**
 * Configuration problems are collected, not thrown one by one, so the exit
 * message names every missing or invalid key at once (spec §4.3: "anything
 * missing makes startup fail with a message naming the variable").
 */

export interface ConfigIssue {
  /** Dotted YAML path, e.g. `encryption.master_key`. */
  readonly path: string;
  /** Environment variable(s) that set the same key, if any. */
  readonly env: readonly string[];
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatIssue(issue: ConfigIssue): string {
  const env = issue.env.length > 0 ? ` (env: ${issue.env.join(' or ')})` : '';
  return `${issue.path}: ${issue.message}${env}`;
}

function formatIssues(issues: readonly ConfigIssue[]): string {
  const noun = issues.length === 1 ? 'problem' : 'problems';
  const lines = issues.map((i) => `  - ${formatIssue(i)}`);
  return [`Invalid instance configuration (${issues.length} ${noun}):`, ...lines].join('\n');
}

/** Accumulates issues during loading and validation. */
export class IssueList {
  readonly items: ConfigIssue[] = [];

  add(path: string, message: string, env: readonly string[] = []): void {
    this.items.push({ path, env, message });
  }

  missing(path: string, env: readonly string[] = []): void {
    this.add(path, 'missing required key', env);
  }

  throwIfAny(): void {
    if (this.items.length > 0) throw new ConfigError(this.items);
  }
}
