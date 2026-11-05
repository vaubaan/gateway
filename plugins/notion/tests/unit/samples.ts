/**
 * One realistic call (or a refused one) per tool : the plugin's own `examples`
 * (`src/examples.ts`), the table the catalog coverage, the identifier proof and
 * the catalog tests run on.
 */
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { notionPlugin } from '../../src/index.ts';

export const SAMPLES: ToolSamples = notionPlugin.examples;
