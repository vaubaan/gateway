/**
 * The site's proxy (Next.js 16): the collector's host serves the collector
 * only, and a page asked as Markdown is answered with its twin. Decisions in
 * `site/routing.ts`. `COLLECTOR_HOST` is read at request time: the static
 * pages are built without it.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { COLLECTOR_ROBOTS_TXT } from '@/content/outputs';
import { hostDecision, hostOf, markdownTwinOf, wantsMarkdown } from '@/site/routing';

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const decision = hostDecision(
    hostOf(request.headers.get('host')),
    pathname,
    process.env.COLLECTOR_HOST,
  );
  if (decision === 'not-found') return new NextResponse(null, { status: 404 });
  if (decision === 'collector-robots') {
    return new NextResponse(COLLECTOR_ROBOTS_TXT, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (decision === 'collector-route') return NextResponse.next();

  if (wantsMarkdown(request.headers.get('accept'))) {
    const twin = markdownTwinOf(pathname);
    if (twin) return NextResponse.rewrite(new URL(twin, request.url));
  }
  return NextResponse.next();
}
