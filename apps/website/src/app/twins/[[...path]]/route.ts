/**
 * The Markdown twin of every page (website spec §2.6), reached through the
 * proxy from the page's `.md` address or from `Accept: text/markdown`:
 * `/twins` is the home page, `/twins/docs/install` the install page. The
 * pages under `/plugins` are rendered with the collector read; the rest is
 * the generated Markdown.
 */
import { liveSite, pageMarkdown } from '@/site/live';

// HEALTH_REVALIDATE_SECONDS: the collector is read again at most once an hour.
export const revalidate = 3600;

interface Context {
  readonly params: Promise<{ path?: string[] }>;
}

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { path = [] } = await context.params;
  const pagePath = `/${path.join('/')}`;
  const markdown = pageMarkdown(pagePath, await liveSite());
  if (markdown === null) return new Response(null, { status: 404 });
  return new Response(markdown, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
