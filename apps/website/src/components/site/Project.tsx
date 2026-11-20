/**
 * The project switch (website spec §2.1): "a developer" or "a consultant",
 * two radios that show one set of examples and drawings. It works without
 * script — `globals.css` hides `[data-project]` blocks with `:has()` on the
 * checked radio —; with script, the choice is kept in this browser's storage
 * and nowhere else. `/consultants` opens on the consultant, whatever is kept.
 */
import type { ReactNode } from 'react';

import { MarkdownBody } from '../MarkdownBody';
import {
  drawingInfo,
  drawingSrc,
  PROJECTS,
  type DrawingName,
  type Project,
} from '../../site/drawings';
import { CONSULTANT_CAVEAT, DEV_CAVEAT, isShared, type Text } from '../../site/product-pages';

/** The key in `localStorage`; nothing else is stored, nothing is sent. */
export const PROJECT_STORAGE_KEY = 'vaubaan-project';

export const PROJECT_RADIO_ID: Readonly<Record<Project, string>> = {
  dev: 'project-dev',
  consultant: 'project-consultant',
};

/**
 * Restores the kept choice before the rest of the page paints, and keeps the
 * next one. Every storage access may throw (private windows, blocked storage):
 * the page then simply stays on the radio's own state.
 */
export const REMEMBER_SCRIPT = `(function(){try{var f=document.currentScript.previousElementSibling;var k=${JSON.stringify(PROJECT_STORAGE_KEY)};if(!f.hasAttribute('data-forced')){var v=null;try{v=localStorage.getItem(k)}catch(e){}var r=v&&document.getElementById('project-'+v);if(r)r.checked=true}f.addEventListener('change',function(e){try{localStorage.setItem(k,e.target.value)}catch(x){}})}catch(e){}})();`;

/** The services of each project are named by the line under the switch. */
const OPTIONS: Readonly<Record<Project, { readonly who: string }>> = {
  dev: { who: 'A developer' },
  consultant: { who: 'A consultant' },
};

export function ProjectSwitch({ initial = 'dev' }: { readonly initial?: Project }) {
  return (
    <div className="flex flex-col gap-2">
      <fieldset
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
        {...(initial === 'consultant' ? { 'data-forced': '' } : {})}
      >
        <legend className="float-left mr-1 text-sm text-muted-foreground">Examples for</legend>
        <div className="inline-flex whitespace-nowrap rounded-lg border border-border bg-muted p-0.5">
          <input
            type="radio"
            name="project"
            id={PROJECT_RADIO_ID.dev}
            value="dev"
            defaultChecked={initial === 'dev'}
            className="peer/dev sr-only"
          />
          <label
            htmlFor={PROJECT_RADIO_ID.dev}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-muted-foreground peer-checked/dev:bg-card peer-checked/dev:font-semibold peer-checked/dev:text-foreground peer-checked/dev:ring-1 peer-checked/dev:ring-border-strong peer-focus-visible/dev:outline-2 peer-focus-visible/dev:outline-ring"
          >
            {OPTIONS.dev.who}
          </label>
          <input
            type="radio"
            name="project"
            id={PROJECT_RADIO_ID.consultant}
            value="consultant"
            defaultChecked={initial === 'consultant'}
            className="peer/consultant sr-only"
          />
          <label
            htmlFor={PROJECT_RADIO_ID.consultant}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-muted-foreground peer-checked/consultant:bg-card peer-checked/consultant:font-semibold peer-checked/consultant:text-foreground peer-checked/consultant:ring-1 peer-checked/consultant:ring-border-strong peer-focus-visible/consultant:outline-2 peer-focus-visible/consultant:outline-ring"
          >
            {OPTIONS.consultant.who}
          </label>
        </div>
      </fieldset>
      <script
        // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- a constant of this file, no data in it
        dangerouslySetInnerHTML={{ __html: REMEMBER_SCRIPT }}
      />
      <div data-project="dev" className="max-w-measure text-sm text-muted-foreground">
        <MarkdownBody markdown={DEV_CAVEAT} />
      </div>
      <div data-project="consultant" className="max-w-measure text-sm text-muted-foreground">
        <MarkdownBody markdown={CONSULTANT_CAVEAT} />
      </div>
    </div>
  );
}

/** A block shown for one project only. */
export function ForProject({
  project,
  children,
}: {
  readonly project: Project;
  readonly children: ReactNode;
}) {
  return <div data-project={project}>{children}</div>;
}

/** Markdown the same for both projects, or one per project. */
export function VariantText({ text }: { readonly text: Text }) {
  if (isShared(text)) return <MarkdownBody markdown={text} />;
  return (
    <>
      {PROJECTS.map((p) => (
        <ForProject key={p} project={p}>
          <MarkdownBody markdown={text[p]} />
        </ForProject>
      ))}
    </>
  );
}

/**
 * A drawing in both projects, light or dark after the system: a `<picture>`
 * per project, the hidden one never loaded (lazy). At phone width it keeps a
 * readable size and scrolls sideways in its own box, never the page; a tap
 * opens the drawing alone, where the browser zooms it.
 */
export function Drawing({
  name,
  eager = false,
}: {
  readonly name: DrawingName;
  readonly eager?: boolean;
}) {
  return (
    <figure className="my-6">
      {PROJECTS.map((p) => {
        const info = drawingInfo(name, p);
        return (
          <ForProject key={p} project={p}>
            <a
              href={drawingSrc(name, p, 'light')}
              className="block overflow-x-auto rounded-xl"
              title="Open the drawing alone"
            >
              <picture>
                <source media="(prefers-color-scheme: dark)" srcSet={drawingSrc(name, p, 'dark')} />
                <img
                  src={drawingSrc(name, p, 'light')}
                  alt={info.desc}
                  width={info.w}
                  height={info.h}
                  loading={eager ? 'eager' : 'lazy'}
                  decoding="async"
                  className="h-auto w-full min-w-[640px]"
                />
              </picture>
            </a>
          </ForProject>
        );
      })}
    </figure>
  );
}
