/**
 * `/manifest.webmanifest` — what makes the interface installable from the browser (spec
 * §4.2 bis: installed, it is the mobile client). Named after the instance, as every tab
 * is (§4.2); the public URL's host stands in without a name. Colours are the paper of the
 * light theme, from the tokens the self-contained documents repeat (`DOCUMENT_TOKENS`).
 *
 * Served to anyone, like the icons: it says nothing a sign-in page does not.
 */
import type { MetadataRoute } from 'next';

import { instanceIdentity } from '@/lib/instance';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';
import { DOCUMENT_TOKENS } from '@/server/http/document';

export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { label } = await instanceIdentity();
  const paper = DOCUMENT_TOKENS.light['--paper'];
  return {
    name: label,
    short_name: label,
    description: NOTIFICATION_WORDS.installed,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: paper,
    theme_color: paper,
    icons: [
      { src: '/logo-vaubaan.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/logo-vaubaan.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
