/**
 * The tabs of Activity, a row under the path bar like the local navigation of
 * Settings: the Overview (`/activity` itself, the home of Activity, by
 * mission), the Record (the audit) and the Timeline (the mission log events of
 * every mission the reader may read). Pure; `activity/layout.tsx` renders it,
 * and a unit test pins that every entry leads to a page that exists.
 */
import type { SubNavGroup } from '@/components/ui';
import { ACTIVITY_TABS } from '@/lib/vocabulary';

export function activityNav(): SubNavGroup[] {
  return [{ items: [ACTIVITY_TABS.overview, ACTIVITY_TABS.record, ACTIVITY_TABS.timeline] }];
}
