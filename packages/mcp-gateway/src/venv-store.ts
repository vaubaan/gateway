/**
 * ProjectEnvVarStore — opaque per-project secret store ("venv").
 *
 * Values are written server-side by `_to_venv` tools and consumed
 * server-side by `_from_venv` tools. They are NEVER returned to
 * the MCP caller (the LLM).
 *
 * Spec : docs/spec/project-env-vars.md §4.
 */

export interface VenvEntry {
  key: string;
  source: string;
  updated_at: string;
}

export interface VenvStore {
  put(projectId: string, key: string, value: string, source: string): Promise<void>;
  get(projectId: string, key: string): Promise<string>;
  has(projectId: string, key: string): Promise<boolean>;
  list(projectId: string): Promise<VenvEntry[]>;
  delete(projectId: string, key: string): Promise<void>;
}
