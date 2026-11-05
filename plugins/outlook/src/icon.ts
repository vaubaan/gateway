/**
 * The mark of the service, as the web interface draws it: the `d` of one SVG
 * path on a 24×24 grid, filled with the brand colour declared below, on a
 * neutral fill beside the service's name (ADR service-icons-declared-by-the-plugin).
 *
 * Drawn for this plugin (Simple Icons removed Microsoft's marks): a tile
 * holding an O, beside an envelope with its flap. Holes are subpaths wound
 * the other way, so the default `nonzero` fill rule keeps them open.
 */
export const OUTLOOK_ICON =
  'M1 4.5h13v15H1zM7.5 7.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4zM7.5 9.6a2.4 2.4 0 1 1 0 4.8a2.4 2.4 0 1 1 0-4.8zM15 7h8v10h-8zM15 9.6l4 3l4-3V8.2l-4 3l-4-3z';

/** The colour the mark is drawn in (`#RRGGBB`): Outlook blue. */
export const OUTLOOK_ICON_COLOR = '#0F6CBD';
