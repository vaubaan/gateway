/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the brand colour declared below, on a
 * neutral fill beside the service's name (ADR service-icons-declared-by-the-plugin).
 *
 * A 7 in a frame, drawn by hand on the 24-unit grid: Context7 publishes no vector mark in a public-domain set.
 */
export const CONTEXT7_ICON =
  'M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm.4 2.4v15.2h15.2V4.4zM7.3 7.2h9.4v2.3l-5 7.3H9.1l4.9-7.4H7.3z';

/**
 * The colour the mark is drawn in (`#RRGGBB`): chosen here, a violet: Context7 publishes no brand colour. A near-black
 * colour is drawn in the ink of the dark theme, so the mark stays visible.
 */
export const CONTEXT7_ICON_COLOR = '#5B5BD6';
