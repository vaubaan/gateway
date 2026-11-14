/**
 * The tabs of Activity, a row under the path bar like the local navigation of
 * Settings: the Record (the audit) and the Timeline (the session events of
 * every mission the reader may read). Pure; `activity/layout.tsx` renders it,
 * and a unit test pins that every entry leads to a page that exists.
 *
 * A later Overview tab takes `/activity` itself: it goes first, with `exact`.
 */
import type { SubNavGroup } from '@/components/ui';
import { ACTIVITY_TABS } from '@/lib/vocabulary';

export function activityNav(): SubNavGroup[] {
  return [{ items: [ACTIVITY_TABS.record, ACTIVITY_TABS.timeline] }];
}
