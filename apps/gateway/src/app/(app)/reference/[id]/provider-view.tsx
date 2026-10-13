'use client';

/**
 * The body of a provider's reference: one section in view at a time, behind
 * tabs, in the order a reader needs them — the presets (the ready-made
 * answers), the risks behind them, then the data model and the tools as
 * reference material. A provider whose data model has several planes gets a
 * plane control that slices every section at once.
 *
 * The URL fragment drives it: `#presets`, `#risks`, `#data-model`, `#tools`
 * select a tab; `#risk-<id>` opens the Risks tab on a plane that shows the
 * entry, unfolds it and scrolls to it; `#preset-<id>` opens the Presets tab
 * and marks the column. Every other page links here with those fragments.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { RiskMarkers, VectorLegend } from '@/components/risk/RiskExplain';
import {
  Badge,
  Glyph,
  HelpButton,
  KindLegend,
  TabList,
  TabPanel,
  useHelp,
  type TabItem,
} from '@/components/ui';
import { DEPRECATED_NOTE, FALLBACK_NOTE, noteBody } from '@/server/missions/catalog-view';
import { REFERENCE_SECTIONS } from '@/server/providers/links';
import { OTHER_PLANE } from '@/server/providers/planes';
import { OTHER_PLANE_NOTE, type ProviderReference } from '@/server/providers/reference';

import styles from '../reference.module.css';
import { DataModelSection } from './data-model';
import { PresetMatrix } from './preset-matrix';
import { RiskList } from './risk-list';
import { ToolTable } from './tool-table';

const TAB_IDS = ['presets', 'risks', 'data-model', 'tools'] as const;
type TabId = (typeof TAB_IDS)[number];

/** Every plane at once: the state of the plane control when nothing is sliced. */
const ALL_PLANES = 'all';
const TABS_BASE = 'provider';
const HELP_PANEL_ID = 'provider-help';

function isTab(raw: string): raw is TabId {
  return (TAB_IDS as readonly string[]).includes(raw);
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
  if (isTab(fragment)) return { tab: fragment, target: null, risk: null, planes: [] };
  const entry = reference.risk_groups
    .flatMap((group) => group.entries)
    .find((candidate) => candidate.anchor === fragment);
  if (entry) {
    return { tab: 'risks', target: entry.anchor, risk: entry.base_id, planes: entry.planes };
  }
  const preset = reference.presets.find((candidate) => candidate.anchor === fragment);
  if (preset) return { tab: 'presets', target: preset.anchor, risk: null, planes: [] };
  return null;
}

export function ProviderView({ reference }: { reference: ProviderReference }) {
  const [tab, setTab] = useState<TabId>('presets');
  const [plane, setPlane] = useState<string>(ALL_PLANES);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The element a fragment pointed at, and a counter so that following the same link twice scrolls twice.
  const [target, setTarget] = useState<{ id: string; turn: number } | null>(null);
  const [helpOpen, setHelpOpen] = useHelp('provider-reference');
  const bar = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const follow = useCallback(
    (fragment: string) => {
      if (fragment === REFERENCE_SECTIONS.legend) {
        setHelpOpen(true);
        return;
      }
      const destination = destinationOf(reference, fragment);
      if (!destination) return;
      setTab(destination.tab);
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

  // The groups of the risk list stick under the bar, whatever its height (one row or two).
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = () => root.current?.style.setProperty('--bar-height', `${node.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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

  const inPlane = useCallback(
    (planes: readonly string[]) => plane === ALL_PLANES || planes.includes(plane),
    [plane],
  );
  const groups = useMemo(
    () =>
      reference.risk_groups
        .map((group) => ({ ...group, entries: group.entries.filter((e) => inPlane(e.planes)) }))
        .filter((group) => group.entries.length > 0),
    [reference, inPlane],
  );
  const tools = useMemo(
    () => reference.tools.filter((tool) => inPlane(tool.planes)),
    [reference, inPlane],
  );
  const planes = useMemo(
    () => reference.planes.filter((tree) => plane === ALL_PLANES || tree.slug === plane),
    [reference, plane],
  );
  const riskCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const sliced = reference.plane_filters.length > 0;

  const tabs: readonly TabItem<TabId>[] = [
    { id: 'presets', label: 'Presets', count: reference.presets.length },
    { id: 'risks', label: 'Risks', count: riskCount },
    { id: 'data-model', label: 'Data model' },
    { id: 'tools', label: 'Tools', count: tools.length },
  ];

  return (
    <div ref={root} className={styles.view}>
      <div ref={bar} className={styles.bar}>
        <div className={styles.barRow}>
          <TabList
            base={TABS_BASE}
            label={`${reference.name} reference`}
            tabs={tabs}
            active={tab}
            onSelect={selectTab}
          />
          <HelpButton
            open={helpOpen}
            onToggle={() => setHelpOpen(!helpOpen)}
            controls={HELP_PANEL_ID}
            label="How to read this page"
          />
        </div>
        {sliced && (
          <fieldset className={styles.planes} data-testid="plane-control">
            <legend className={styles.planesLegend}>Plane</legend>
            {[
              { slug: ALL_PLANES, description: 'Every plane of the data model', risks: null },
              ...reference.plane_filters,
            ].map((filter) => (
              <label
                key={filter.slug}
                className={[styles.plane, plane === filter.slug ? styles.planeOn : ''].join(' ')}
                title={filter.description ?? undefined}
                data-kind="plane"
              >
                <input
                  type="radio"
                  name="plane"
                  value={filter.slug}
                  checked={plane === filter.slug}
                  onChange={() => setPlane(filter.slug)}
                />
                {filter.slug !== ALL_PLANES && filter.slug !== OTHER_PLANE && (
                  <Glyph name="plane" />
                )}
                <span>{filter.slug === ALL_PLANES ? 'All' : filter.slug}</span>
                {filter.risks !== null && (
                  <span className={styles.planeCount} aria-label={`${filter.risks} risks`}>
                    {filter.risks}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        )}
      </div>

      <div
        id={HELP_PANEL_ID}
        className={styles.help}
        hidden={!helpOpen}
        data-testid="reference-help"
      >
        <section>
          <h2 className={styles.helpTitle}>Presets and risks</h2>
          <p>
            A <strong>risk</strong> is one thing a human may accept for an agent: “open a pull
            request”, “write a production variable”. A mission lists the risks it accepts, each with
            a <strong>quota</strong> (actions per period), a <strong>rate limit</strong> and a{' '}
            <strong>gate</strong> (auto, or your approval for each action). A call that touches a
            risk the mission does not list is refused. A <strong>preset</strong> is a starting
            selection of risks with budgets, shipped by the plugin: picking one never grants more
            than you hold on the connection, and a preset changed in a later version does not change
            an existing mission. The table shows each preset against the whole catalog; at mission
            creation it is bounded by your authority and by the resources you select.
          </p>
        </section>
        <section>
          <h2 className={styles.helpTitle}>How to read a risk</h2>
          <p>
            Each risk carries a six-cell strip — its <em>vector</em>. It explains the risk and
            orders the lists; nothing is decided from it. A plain cell is the mildest value of its
            axis; a highlighted one is further up the scale, and the cell always writes the value.
          </p>
          <VectorLegend />
          <p>
            <strong>Account-scoped</strong> risks are accepted once.{' '}
            <strong>Environment-scoped</strong> risks are accepted separately in each environment
            they list, and can never be accepted in an environment they do not list.
          </p>
          <p>
            <RiskMarkers fallback deprecated={false} /> {noteBody(FALLBACK_NOTE)}
          </p>
          <p>
            <RiskMarkers fallback={false} deprecated /> {noteBody(DEPRECATED_NOTE)}
          </p>
        </section>
        <section>
          <h2 className={styles.helpTitle}>What the glyphs mean</h2>
          <p>
            A glyph says what kind of thing a name is, on every page. It never says how severe or in
            what state: read, write and irreversible, the gate and the strip keep their own marks (
            <Badge tone="warning">approval</Badge>, an outlined word).
          </p>
          <KindLegend />
        </section>
        {sliced && (
          <section>
            <h2 className={styles.helpTitle}>Planes</h2>
            <p>{OTHER_PLANE_NOTE}</p>
          </section>
        )}
      </div>

      {tab === 'presets' && (
        <TabPanel base={TABS_BASE} id="presets" className={styles.panel}>
          <PresetMatrix
            presets={reference.presets}
            groups={groups}
            target={target?.id ?? null}
            onGo={go}
          />
        </TabPanel>
      )}
      {tab === 'risks' && (
        <TabPanel base={TABS_BASE} id="risks" className={styles.panel}>
          <RiskList
            groups={groups}
            expanded={expanded}
            onExpanded={setExpanded}
            target={target?.id ?? null}
            onGo={go}
          />
        </TabPanel>
      )}
      {tab === 'data-model' && (
        <TabPanel base={TABS_BASE} id="data-model" className={styles.panel}>
          <DataModelSection planes={planes} environment={reference.environment} />
        </TabPanel>
      )}
      {tab === 'tools' && (
        <TabPanel base={TABS_BASE} id="tools" className={styles.panel}>
          <ToolTable
            tools={tools}
            total={reference.tools.length}
            providerName={reference.name}
            experimental={reference.experimental}
            showPlane={sliced}
            onGo={go}
          />
        </TabPanel>
      )}
    </div>
  );
}
