/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the brand colour declared below, on a
 * neutral fill beside the service's name (ADR service-icons-declared-by-the-plugin).
 *
 * A terminal prompt (`>_`), drawn by hand on the 24-unit grid: SSH is a protocol and has no brand mark.
 */
export const SSH_ICON = 'M3.7 4.6 11.6 12l-7.9 7.4L2 17.7 7.9 12 2 6.3zM12.5 17.2h9.5v2.4h-9.5z';

/**
 * The colour the mark is drawn in (`#RRGGBB`): chosen here, a terminal green: SSH is a protocol and has no brand. A near-black
 * colour is drawn in the ink of the dark theme, so the mark stays visible.
 */
export const SSH_ICON_COLOR = '#16A34A';
