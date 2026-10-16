/**
 * Next glue for the instance's name (spec §4.2): the metadata the layouts of
 * the human surface export, so that the tab of each instance carries its
 * name. What the name is lives in `@/server/instance`; the words in
 * `components/shell/instance-label`.
 */
import type { Metadata } from 'next';

import { documentTitle } from '@/components/shell/instance-label';
import { getRoot } from '@/server/compose';
import type { InstanceIdentity } from '@/server/instance';

/** The identity of this instance, for a server component. */
export async function instanceIdentity(): Promise<InstanceIdentity> {
  return (await getRoot()).instance.name.identity();
}

/** `generateMetadata` of a layout or page: the title "<name> · Vaubaan". */
export async function instanceMetadata(): Promise<Metadata> {
  return { title: documentTitle(await instanceIdentity()) };
}
