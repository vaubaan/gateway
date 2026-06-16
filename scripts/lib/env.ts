import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const SUPABASE_POOLER_HOST = 'aws-1-eu-west-3.pooler.supabase.com';

export function readEnvFile(relativePath: string): Record<string, string> {
  const raw = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+?)(?:\s+#.*)?$/);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  return env;
}

export function requireKeys<K extends string>(
  env: Record<string, string>,
  keys: readonly K[],
  source: string,
): Record<K, string> {
  for (const key of keys) {
    if (!env[key]) throw new Error(`${key} missing in ${source}`);
  }
  return env;
}

export function readCoreEnv(): { projectRef: string; dbPassword: string } {
  const env = requireKeys(
    readEnvFile('.env'),
    ['SUPABASE_CORE_PROJECT_REF', 'VAUBAAN_CORE_DB_PASSWORD'] as const,
    '.env',
  );
  return { projectRef: env.SUPABASE_CORE_PROJECT_REF, dbPassword: env.VAUBAAN_CORE_DB_PASSWORD };
}
