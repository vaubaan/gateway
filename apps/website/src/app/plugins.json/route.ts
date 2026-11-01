/**
 * `/plugins.json` (website spec §2.6): every plugin as data, with the health
 * the plugin pages show, read from the collector at request time.
 */
import { livePluginsJson, liveSite } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  return new Response(livePluginsJson(await liveSite()), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
