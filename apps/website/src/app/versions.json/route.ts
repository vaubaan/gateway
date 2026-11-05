/**
 * `/versions.json` (website spec §2.4 bis): the released gateway, each plugin's released
 * version and the advisories, for the instances that compare themselves with it. Static:
 * rendered once at build from `src/content/releases.json` and `advisories.json`, so
 * `generated_at` is the build time and a malformed data file fails the build. Served to
 * anyone, cacheable; reading it tells the site nothing about the instance.
 */
import advisories from '@/content/advisories.json';
import releases from '@/content/releases.json';
import { buildVersionsFeed } from '@/content/versions-feed';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(JSON.stringify(buildVersionsFeed(releases, advisories, new Date())), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
