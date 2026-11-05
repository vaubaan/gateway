/**
 * One realistic call (or a refused one) per tool : the plugin's own `examples`
 * (`src/examples.ts`), the table the catalog coverage, the data-model walk and
 * the identifier proof run on.
 */
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { asanaPlugin } from '../../src/index.ts';

export const SAMPLES: ToolSamples = asanaPlugin.examples ?? {};
