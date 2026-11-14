/**
 * Activity: one place, its tabs in a row under the path bar (`activityNav`),
 * then the tab's own page — the Record or the Timeline.
 */
import { activityNav } from '@/components/shell/activity-nav';
import { SubNav, SubNavFrame } from '@/components/ui';
import { NAV } from '@/lib/vocabulary';

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  return (
    <SubNavFrame nav={<SubNav label={NAV.activity.label} groups={activityNav()} />}>
      {children}
    </SubNavFrame>
  );
}
