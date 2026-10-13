'use client';

/**
 * The gallery of `/design`: the sections, in the order a page is built — the
 * tokens, the frame, what fills it, what answers the person. The shell around
 * it is the application's own, so the side navigation and the theme toggle
 * are seen live; resize the window to see the collapsed form.
 */
import { Callout, PageHeader, SubNav, SubNavFrame } from '@/components/ui';
import { PAGES } from '@/lib/vocabulary';

import { ListSections, PermissionSections } from './sections-data';
import { GallerySection } from './specimen';
import { FormSections, LegacySections, OverlaySections, StateSections } from './sections-feedback';
import {
  ButtonSections,
  MarkSections,
  PageFrameSections,
  TokenSections,
} from './sections-foundation';
import { WaitingSections } from './sections-waiting';

/** The sections, as the local navigation lists them. Each `id` is a section anchor. */
export const GALLERY_SECTIONS: readonly {
  readonly group: string;
  readonly items: readonly { readonly id: string; readonly label: string }[];
}[] = [
  {
    group: 'Tokens',
    items: [
      { id: 'colour', label: 'Colour' },
      { id: 'type', label: 'Type' },
      { id: 'space', label: 'Space and radius' },
    ],
  },
  {
    group: 'Frame',
    items: [
      { id: 'shell', label: 'Shell' },
      { id: 'page-header', label: 'Page header' },
      { id: 'section', label: 'Section heading' },
      { id: 'buttons', label: 'Buttons' },
    ],
  },
  {
    group: 'Marks',
    items: [
      { id: 'status', label: 'Status marks' },
      { id: 'who', label: 'People, keys, ids' },
    ],
  },
  {
    group: 'Content',
    items: [
      { id: 'rows', label: 'List rows' },
      { id: 'table', label: 'Data table' },
      { id: 'meter', label: 'Meter' },
      { id: 'permission', label: 'Permission row' },
      { id: 'allow', label: 'Can / Asks / Cannot' },
      { id: 'answer', label: 'Answer row' },
      { id: 'empty', label: 'Empty, first run' },
      { id: 'callout', label: 'Callout' },
    ],
  },
  {
    group: 'Interaction',
    items: [
      { id: 'dialog', label: 'Dialog' },
      { id: 'disclosure', label: 'Show details' },
      { id: 'filters', label: 'Tabs, filters, search' },
      { id: 'toast', label: 'Toast' },
      { id: 'forms', label: 'Form fields' },
      { id: 'code', label: 'Code' },
      { id: 'legacy', label: 'Kept for older pages' },
    ],
  },
  {
    group: 'Now and Waiting for you',
    items: [
      { id: 'running', label: 'Running list' },
      { id: 'inbox', label: 'Inbox' },
      { id: 'request', label: 'Open request' },
    ],
  },
];

export function Gallery() {
  return (
    <>
      <PageHeader title={PAGES.design.title} lede={PAGES.design.lede} width="wide" />
      <SubNavFrame
        nav={
          <SubNav
            label="Components"
            groups={GALLERY_SECTIONS.map(({ group, items }) => ({
              label: group,
              items: items.map(({ id, label }) => ({ label, href: `#${id}`, current: false })),
            }))}
          />
        }
      >
        <TokenSections />
        <GallerySection
          id="shell"
          title="Shell"
          rule="The shell is the one around this page: seven entries, the person and the theme toggle at the foot. It is navigation, not a status panel."
        >
          <Callout tone="info" title="See it live">
            Press the theme toggle at the bottom left: System, Light, Dark — the choice is kept and
            the page never flashes at load. Narrow the window under 1024 px to see the navigation
            collapse to its icons, and under 640 px to see it become a bar. “Waiting for you” shows
            its count in amber when something waits.
          </Callout>
        </GallerySection>
        <PageFrameSections />
        <ButtonSections />
        <MarkSections />
        <ListSections />
        <PermissionSections />
        <StateSections />
        <OverlaySections />
        <FormSections />
        <LegacySections />
        <WaitingSections />
      </SubNavFrame>
    </>
  );
}
