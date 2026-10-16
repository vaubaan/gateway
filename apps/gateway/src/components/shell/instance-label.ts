/**
 * How the interface says which instance this is (spec §4.2): the words of the
 * brand, of its tooltip and of the browser tab, from `InstanceIdentity`.
 * Pure; the shell, the sign-in frame and the layouts' metadata use it.
 *
 * Every string here is rendered as text (a React child, a `title` attribute,
 * the document `<title>`), never as markup.
 */
import { PRODUCT } from '@/lib/vocabulary';
import type { InstanceIdentity } from '@/server/instance';

/** The title of every page, what a browser tab shows: "<name> · Vaubaan". */
export function documentTitle(identity: Pick<InstanceIdentity, 'label'>): string {
  return `${identity.label} · ${PRODUCT.name}`;
}

/**
 * The tooltip of the brand: the product, the name, and the host the name
 * stands for, so that an administrator can still tell which address it is.
 */
export function brandTooltip(identity: Pick<InstanceIdentity, 'name' | 'host'>): string {
  return identity.name === null
    ? `${PRODUCT.name} · ${identity.host}`
    : `${PRODUCT.name} · ${identity.name} · ${identity.host}`;
}
