/**
 * The collector's only way to the dedicated Supabase project: its REST API,
 * with the publishable key, as `anon`. RLS (insert only) and the `CHECK`
 * constraints of `deploy/collector/schema.sql` stay the final word.
 *
 * Nothing of the instance's request is forwarded: no header, so neither
 * `x-forwarded-for` nor any other carrier of the instance's address reaches
 * Supabase, which sees the collector's own address only.
 */
import type { CollectorConfig } from './config';

export type StoreResult = 'stored' | 'rate-limited' | 'refused' | 'unavailable';

const HTTP_TOO_MANY_REQUESTS = 429;
const STORE_TIMEOUT_MS = 8_000;

export interface SupabaseRest {
  insert(table: string, rows: readonly object[]): Promise<StoreResult>;
  /** `GET /rest/v1/<view>?<params>`: the JSON body, or `null` when it could not be read. */
  select(view: string, params: URLSearchParams): Promise<unknown>;
}

function keyHeaders(config: CollectorConfig): Record<string, string> {
  return { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}` };
}

function restUrl(config: CollectorConfig, resource: string): URL {
  return new URL(`/rest/v1/${resource}`, config.supabaseUrl);
}

export function createSupabaseRest(
  config: CollectorConfig,
  fetchImpl: typeof fetch = fetch,
): SupabaseRest {
  return {
    async insert(table, rows) {
      if (rows.length === 0) return 'stored';
      let response: Response;
      try {
        response = await fetchImpl(restUrl(config, table), {
          method: 'POST',
          headers: {
            ...keyHeaders(config),
            'content-type': 'application/json',
            prefer: 'return=minimal',
          },
          body: JSON.stringify(rows),
          redirect: 'error',
          signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
        });
      } catch {
        return 'unavailable';
      }
      // The body may echo a row: never read, never logged.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return 'stored';
      if (response.status === HTTP_TOO_MANY_REQUESTS) return 'rate-limited';
      return response.status >= 500 ? 'unavailable' : 'refused';
    },

    async select(view, params) {
      const url = restUrl(config, view);
      url.search = params.toString();
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { ...keyHeaders(config), accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        return (await response.json()) as unknown;
      } catch {
        return null;
      }
    },
  };
}
