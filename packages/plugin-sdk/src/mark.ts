/**
 * The service's mark (`ServicePlugin.icon`, `iconColor`): the patterns a plugin's
 * declaration is checked against. A module of its own, with no import, so that the
 * archive tools (`@vaubaan/plugin-sdk/archive`) check a mark under plain Node.
 */

/**
 * `ServicePlugin.icon` : the `d` attribute of one SVG path — a drawing
 * command first, then commands, numbers and separators only. No markup, no
 * `url(…)`, nothing a page could not put inside `<path d="…">` as it is.
 */
export const SVG_PATH_DATA_PATTERN = /^[Mm][0-9A-Za-z.,\s+-]*$/;

/** `ServicePlugin.iconColor` : one sRGB colour as six hex digits, `#RRGGBB`, nothing a stylesheet could misread. */
export const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
