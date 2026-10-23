/**
 * `/design` — the interface reference: every component of the design system,
 * in every state, in both themes at once. It is what a page is built from and
 * what a reviewer compares a page with (spec style-guide §7).
 *
 * Open to any session, the bootstrap operator included: it shows no account,
 * no mission and no credential — every specimen is invented.
 */
import { requirePrincipal } from '@/lib/auth/session';
import { providerCards } from '@/server/providers/reference';

import { Gallery } from './gallery';
import type { GalleryIcons } from './specimen';

export const dynamic = 'force-dynamic';

export default async function DesignPage() {
  const { root } = await requirePrincipal();
  const icons: GalleryIcons = Object.fromEntries(
    providerCards(root.registry).flatMap((card) => (card.icon ? [[card.id, card.icon]] : [])),
  );
  return <Gallery icons={icons} />;
}
