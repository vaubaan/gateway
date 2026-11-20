/**
 * `@vaubaan/design-tokens` — the one token sheet of the app and the site
 * (style guide §3; ADR design-system-on-shadcn-shared-by-the-app-and-the-site).
 *
 * The style sheets are files of the package (`tokens.css`, `theme.css`),
 * generated from `palette.ts`; this entry exports the palette, the contrast
 * pairs as data and the colour maths that checks them.
 */
export {
  CONTRAST_PAIRS,
  SHADCN_TOKENS,
  TOKENS,
  VAUBAAN_TOKENS,
  type ContrastPair,
  type Token,
} from './palette.ts';
export {
  contrastRatio,
  cssOklch,
  hexToOklch,
  hexToRgb,
  luminance,
  oklchToRgb,
  parseOklch,
  rgbToHex,
  type Oklch,
  type Rgb,
} from './color.ts';
export { renderThemeCss, renderTokensCss, renderedSheets } from './render.ts';
