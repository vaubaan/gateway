/**
 * Which entry of the application bar a path belongs to. Pure: the bar marks
 * the current section with it, and a unit test pins the rule.
 */

/** `/missions/abc` is under `/missions`; `/missions-archive` is not. */
export function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
