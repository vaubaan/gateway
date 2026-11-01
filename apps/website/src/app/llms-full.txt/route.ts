/**
 * `/llms-full.txt` (website spec §2.6): the whole site in one Markdown file,
 * the plugin pages with the health read from the collector at request time.
 */
import { liveLlmsFull, liveSite } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  return new Response(liveLlmsFull(await liveSite()), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
