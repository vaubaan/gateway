/**
 * How a service's mark is coloured, in the gateway's interface and on the
 * public site alike (ADR service-icons-declared-by-the-plugin): the plugin
 * declares `icon` (the `d` of one path on a 24-unit grid) and `iconColor`
 * (`#RRGGBB`); both hosts draw the path in that colour on a neutral fill, and
 * in the dark theme a near-black brand turns to the theme's ink, where it
 * would vanish on the dark paper.
 *
 * Pure and browser-safe: the gateway's client components and the site's pages
 * import it at run time (`@vaubaan/shared/service-mark`).
 */

/**
 * Below this relative luminance (sRGB, 0 to 1) a brand colour is close enough
 * to black to vanish on the dark paper: GitHub's #181717 is 0.006, Fly.io's
 * #24175B 0.017; Stripe's #635BFF, the darkest one kept, is 0.17.
 */
export const NEAR_BLACK_LUMINANCE = 0.1;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** sRGB channel (0–255) to linear light, per WCAG 2. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of `#RRGGBB`, `null` for anything else. */
export function relativeLuminance(hex: string): number | null {
  const match = HEX.exec(hex);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((pair) => Number.parseInt(pair, 16)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The colours a mark is drawn in: `light` is the declared colour; `dark` the
 * same, or `null` when the brand is near black and the host draws it in its
 * dark theme's ink. Both `null` without a declared colour: the host's quiet ink.
 */
export interface ServiceMarkColors {
  readonly light: string | null;
  readonly dark: string | null;
}

export function serviceMarkColors(color: string | null | undefined): ServiceMarkColors {
  if (!color) return { light: null, dark: null };
  const luminance = relativeLuminance(color);
  return {
    light: color,
    dark: luminance !== null && luminance < NEAR_BLACK_LUMINANCE ? null : color,
  };
}
