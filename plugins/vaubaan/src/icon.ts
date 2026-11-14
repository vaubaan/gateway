/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the colour declared below, on a neutral
 * fill beside the service's name (ADR service-icons-declared-by-the-plugin).
 *
 * The V of the Vaubaan logo (`apps/gateway/public/logo-vaubaan.svg`, 256-unit
 * grid), scaled to the 24-unit grid: the mark the interface already shows.
 */
export const VAUBAAN_ICON = 'M5.25 6H9l3 9.75L15 6h3.75L13.5 18.75h-3z';

/**
 * The colour the mark is drawn in (`#RRGGBB`): the black of the logo. A
 * near-black colour is drawn in the ink of the dark theme, so the mark stays
 * visible there.
 */
export const VAUBAAN_ICON_COLOR = '#000000';
