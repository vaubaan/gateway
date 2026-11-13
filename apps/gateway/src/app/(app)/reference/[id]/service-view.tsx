'use client';

/**
 * The body of a service's reference: one section in view at a time, behind
 * tabs — the permissions compared across the trust levels (what a person reads
 * before giving any), the tools, then how the service is modelled. A text
 * filter narrows the list in view; a service whose model has several planes
 * gets a plane filter that slices every tab at once.
 *
 * The URL fragment drives it, and every other page links here with one:
 * `#permissions`, `#tools`, `#data-model` select a tab (`#macro-actions`,
 * `#presets` and `#risks` all lead to Permissions);
 * `#risk-<id>` opens Permissions on a plane that shows the entry, unfolds it
 * and scrolls to it; `#macro-<id>` marks the macro-action;
 * `#legend` opens "How to read this page".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  SearchField,
  Segmented,
  TabList,
  TabPanel,
  useRemembered,
  WhyCells,
  type TabItem,
} from '@/components/ui';
import {
  REFERENCE_WORDS,
  ROW_WORDS,
  TREE_LEGEND,
  type WHY_LABELS,
  WHY_ORDER,
} from '@/lib/vocabulary';
import { DEPRECATED_NOTE, FALLBACK_NOTE, noteBody } from '@/lib/missions/catalog-view';
import { REFERENCE_SECTIONS } from '@/lib/providers/links';
import { OTHER_PLANE } from '@/lib/providers/planes';
import { OTHER_PLANE_NOTE, type ProviderReference } from '@/lib/providers/reference';

import styles from '../reference.module.css';
import { DataModelSection } from './data-model';
import { PermissionComparison } from './permissions';
import { ToolList } from './tools';

const TAB_IDS = ['permissions', 'tools', 'data-model'] as const;
type TabId = (typeof TAB_IDS)[number];

/** The sections of the earlier page: links written before still land on the right tab. */
const TAB_ALIASES: Readonly<Record<string, TabId>> = {
  [REFERENCE_SECTIONS.macroActions]: 'permissions',
  // The presets of an earlier page, retired: their links still land on Permissions.
  presets: 'permissions',
  [REFERENCE_SECTIONS.risks]: 'permissions',
};

/** Every plane at once: the state of the plane filter when nothing is sliced. */
const ALL_PLANES = 'all';
const TABS_BASE = 'service';
const HELP_PANEL_ID = 'reference-help';

function tabOf(fragment: string): TabId | null {
  if ((TAB_IDS as readonly string[]).includes(fragment)) return fragment as TabId;
  return TAB_ALIASES[fragment] ?? null;
}

/** Where a fragment leads: a tab, and possibly one entry to show inside it. */
interface Destination {
  readonly tab: TabId;
  /** The element to scroll to and mark. */
  readonly target: string | null;
  /** The catalog entry to unfold. */
  readonly risk: string | null;
  /** The planes the target lives in; empty when the target is not plane-bound. */
  readonly planes: readonly string[];
}

function destinationOf(reference: ProviderReference, fragment: string): Destination | null {
  const tab = tabOf(fragment);
  if (tab) return { tab, target: null, risk: null, planes: [] };
  const entry = reference.risk_groups
    .flatMap((group) => group.entries)
    .find((candidate) => candidate.anchor === fragment);
  if (entry) {
    return { tab: 'permissions', target: entry.anchor, risk: entry.base_id, planes: entry.planes };
  }
  const action = reference.macro_actions.find((candidate) => candidate.anchor === fragment);
  if (action) return { tab: 'permissions', target: action.anchor, risk: null, planes: [] };
  return null;
}

function matches(needle: string, ...haystack: readonly string[]): boolean {
  return needle === '' || haystack.some((text) => text.toLowerCase().includes(needle));
}

export function ServiceView({ reference }: { reference: ProviderReference }) {
  const [tab, setTab] = useState<TabId>('permissions');
  const [plane, setPlane] = useState<string>(ALL_PLANES);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The element a fragment pointed at, and a counter so that following the same link twice scrolls twice.
  const [target, setTarget] = useState<{ id: string; turn: number } | null>(null);
  const [helpOpen, setHelpOpen] = useRemembered('reference:how-to-read');

  const follow = useCallback(
    (fragment: string) => {
      if (fragment === REFERENCE_SECTIONS.legend) {
        setHelpOpen(true);
        return;
      }
      const destination = destinationOf(reference, fragment);
      if (!destination) return;
      setTab(destination.tab);
      if (destination.target !== null) setQuery('');
      if (destination.planes.length > 0) {
        // Keep the reader's plane when it shows the entry; otherwise open the entry's own.
        setPlane((current) =>
          current === ALL_PLANES || destination.planes.includes(current)
            ? current
            : (destination.planes[0] ?? ALL_PLANES),
        );
      }
      const { risk } = destination;
      if (risk !== null) setExpanded((current) => new Set(current).add(risk));
      setTarget((current) =>
        destination.target === null
          ? null
          : { id: destination.target, turn: (current?.turn ?? 0) + 1 },
      );
    },
    [reference, setHelpOpen],
  );

  // The fragment the page was opened with, then every change of it.
  useEffect(() => {
    const read = () => follow(decodeURIComponent(window.location.hash.slice(1)));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [follow]);

  // Once the destination is rendered, bring it into view.
  useEffect(() => {
    if (!target) return;
    document.getElementById(target.id)?.scrollIntoView({ block: 'center' });
  }, [target]);

  /** A link inside the page: followed here, so that the same link works twice in a row. */
  const go = useCallback(
    (fragment: string) => {
      window.history.pushState(null, '', `#${fragment}`);
      follow(fragment);
    },
    [follow],
  );

  function selectTab(next: TabId) {
    setTab(next);
    setTarget(null);
    window.history.replaceState(null, '', `#${next}`);
  }

  const needle = query.trim().toLowerCase();
  const inPlane = useCallback(
    (planes: readonly string[]) => plane === ALL_PLANES || planes.includes(plane),
    [plane],
  );
  const groups = useMemo(
    () =>
      reference.risk_groups
        .map((group) => ({
          ...group,
          entries: group.entries.filter(
            (entry) =>
              inPlane(entry.planes) && matches(needle, entry.label, entry.base_id, entry.reason),
          ),
        }))
        .filter((group) => group.entries.length > 0),
    [reference, inPlane, needle],
  );
  const tools = useMemo(
    () =>
      reference.tools.filter(
        (tool) => inPlane(tool.planes) && matches(needle, tool.name, tool.description),
      ),
    [reference, inPlane, needle],
  );
  const planes = useMemo(
    () => reference.planes.filter((tree) => plane === ALL_PLANES || tree.slug === plane),
    [reference, plane],
  );
  const permissionCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const sliced = reference.plane_filters.length > 0;

  const tabs: readonly TabItem<TabId>[] = [
    { id: 'permissions', label: REFERENCE_WORDS.tabs.permissions, count: permissionCount },
    { id: 'tools', label: REFERENCE_WORDS.tabs.tools, count: tools.length },
    { id: 'data-model', label: REFERENCE_WORDS.tabs.model },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        <TabList
          base={TABS_BASE}
          label={`${reference.name} reference`}
          tabs={tabs}
          active={tab}
          onSelect={selectTab}
        />
        <div className={styles.filters}>
          {tab !== 'data-model' && (
            <SearchField
              label={
                tab === 'tools'
                  ? 'Filter the tools'
                  : `Filter the ${REFERENCE_WORDS.tabs.permissions.toLowerCase()}`
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={styles.search}
            />
          )}
          {sliced && (
            <span data-testid="plane-control">
              <Segmented
                label="Part of the service"
                options={[
                  { value: ALL_PLANES, label: 'All' },
                  ...reference.plane_filters.map((filter) => ({
                    value: filter.slug,
                    label: filter.slug === OTHER_PLANE ? 'other' : filter.slug,
                  })),
                ]}
                value={plane}
                onChange={setPlane}
              />
            </span>
          )}
          <button
            type="button"
            className={styles.linkButton}
            aria-expanded={helpOpen}
            aria-controls={HELP_PANEL_ID}
            onClick={() => setHelpOpen(!helpOpen)}
          >
            {helpOpen ? REFERENCE_WORDS.hideHowToRead : REFERENCE_WORDS.howToRead}
          </button>
        </div>
      </div>

      <div
        id={HELP_PANEL_ID}
        className={styles.help}
        hidden={!helpOpen}
        data-testid="reference-help"
      >
        <p>
          A <strong>permission</strong> is one thing a person may allow an agent to do: “open a pull
          request”, “write a production variable”. A mission lists the permissions it holds, each
          with its <strong>limits</strong> (per period and per minute) and whether it{' '}
          <strong>runs freely</strong> or must <strong>ask first</strong>. A call that needs a
          permission the mission does not hold is refused.
        </p>
        <p>
          A <strong>macro-action</strong> groups the permissions of one thing an agent does on the
          service, in its own words. A mission ticks macro-actions, each at a{' '}
          <strong>trust level</strong>: Careful, Trusting or Autonomous sets, from each permission’s
          row, whether it runs freely, asks first or is left out, and multiplies its limits ×1, ×3
          or ×10. Ticking never gives more than you hold on the account, and a catalog that changes
          in a later version does not change a mission that exists.
        </p>
        <p>
          <strong>Risk</strong> is the row of the permission — {ROW_WORDS[1]},{' '}
          {ROW_WORDS[2].toLowerCase()}, {ROW_WORDS[3].toLowerCase()} or {ROW_WORDS[4].toLowerCase()}{' '}
          — and the reason that put it there. {TREE_LEGEND} The five facts it is read from are shown
          behind “why?”.
        </p>
        <WhyCells
          values={Object.fromEntries(WHY_ORDER.map((axis) => [axis, WHY_QUESTIONS[axis]] as const))}
        />
        <p>
          Some permissions exist <strong>once per environment</strong> (staging, prod…): they are
          held separately for each, and can never be used on a resource of another environment, or
          of none.
        </p>
        <p>
          <strong>{REFERENCE_WORDS.anythingElse}</strong> — {noteBody(FALLBACK_NOTE)}{' '}
          <strong>{REFERENCE_WORDS.retired}</strong> — {noteBody(DEPRECATED_NOTE)}
        </p>
        {sliced && <p>{OTHER_PLANE_NOTE}</p>}
      </div>

      {tab === 'permissions' && (
        <TabPanel base={TABS_BASE} id="permissions" className={styles.panel}>
          <PermissionComparison
            macroActions={reference.macro_actions}
            groups={groups}
            expanded={expanded}
            onExpanded={setExpanded}
            target={target?.id ?? null}
            onGo={go}
            filtered={needle !== '' || plane !== ALL_PLANES}
          />
        </TabPanel>
      )}
      {tab === 'tools' && (
        <TabPanel base={TABS_BASE} id="tools" className={styles.panel}>
          <ToolList
            tools={tools}
            total={reference.tools.length}
            serviceName={reference.name}
            showPlane={sliced}
            onGo={go}
          />
        </TabPanel>
      )}
      {tab === 'data-model' && (
        <TabPanel base={TABS_BASE} id="data-model" className={styles.panel}>
          <DataModelSection planes={planes} environment={reference.environment} />
        </TabPanel>
      )}
    </div>
  );
}

/** What each of the five facts answers, shown in the legend in place of a value. */
const WHY_QUESTIONS: Readonly<Record<keyof typeof WHY_LABELS, string>> = {
  reversibility: 'can it be undone, and at what price?',
  blast: 'how much does one action reach?',
  data: 'what kind of data is exposed?',
  cost: 'can it spend money?',
  visibility: 'who sees the effect?',
};
