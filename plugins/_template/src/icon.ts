/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the brand colour declared below, on a
 * neutral fill beside the service's name (ADR service-icons-declared-by-the-plugin).
 *
 * Replace this placeholder (a rounded square) with the service's mark: a Simple Icons path (`require('simple-icons').si<Name>.path`, CC0 1.0 — say "Simple Icons, CC0 1.0, `<slug>`" here) or one drawn by hand on the same grid.
 */
export const _TEMPLATE_ICON =
  'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm.5 2.5v13h13v-13z';

/**
 * The colour the mark is drawn in (`#RRGGBB`): a placeholder: replace it with the brand colour of the service. A near-black
 * colour is drawn in the ink of the dark theme, so the mark stays visible.
 */
export const _TEMPLATE_ICON_COLOR = '#5B6ABF';
