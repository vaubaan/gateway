/**
 * What the generator (`scripts/generate.ts`) hands the pages: one JSON file,
 * read when a page is rendered. Pages never read the repository themselves;
 * the only thing they read beyond this file is the collector (`live.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PageGroup } from '@/content/outputs';
import type { PluginInfo } from '@/content/plugins';
import type { ValidationThresholds } from '@/content/thresholds';

export const GENERATED_DIR = '.generated';
export const SITE_DATA_FILE = 'site.json';

export interface PageMeta {
  readonly path: string;
  readonly group: PageGroup;
  readonly title: string;
  readonly description: string;
  readonly lastModified: string | null;
}

export interface SiteData {
  readonly thresholds: ValidationThresholds;
  readonly plugins: readonly PluginInfo[];
  /**
   * The Markdown of every page but those under `/plugins`, by path: the home
   * page, the docs and the trust center. The plugin pages carry health and
   * are rendered at request time (`live.ts`).
   */
  readonly markdown: Readonly<Record<string, string>>;
  readonly pages: readonly PageMeta[];
}

let cached: SiteData | null = null;

/** The generated data; throws with the command to run when it is missing. */
export function siteData(): SiteData {
  if (cached === null) {
    const file = join(process.cwd(), GENERATED_DIR, SITE_DATA_FILE);
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as SiteData;
    } catch {
      throw new Error(
        `${file} is missing: run "npm run generate --workspace @vaubaan/website" first`,
      );
    }
  }
  return cached;
}

export function pageMeta(path: string): PageMeta | undefined {
  return siteData().pages.find((p) => p.path === path);
}

/** The generated Markdown of a page that carries no health; throws for one under `/plugins`. */
export function markdownOf(path: string): string {
  const markdown = siteData().markdown[path];
  if (markdown === undefined) throw new Error(`no generated Markdown for ${path}`);
  return markdown;
}
