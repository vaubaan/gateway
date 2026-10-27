/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the brand colour declared below, on a
 * neutral fill beside the service's name (ADRs service-icons-declared-by-the-plugin,
 * service-marks-in-brand-colour).
 *
 * A calendar page with its two rings and five days, drawn by hand on the
 * 24-unit grid: CalDAV is a protocol and has no brand mark.
 */
export const CALDAV_ICON =
  'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v11H5zm2 2v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm-8 4v2h2v-2zm4 0v2h2v-2z';

/**
 * The colour the mark is drawn in (`#RRGGBB`): chosen here, a teal: CalDAV is a protocol and has no brand. A near-black
 * colour is drawn in the ink of the dark theme, so the mark stays visible.
 */
export const CALDAV_ICON_COLOR = '#0F766E';
