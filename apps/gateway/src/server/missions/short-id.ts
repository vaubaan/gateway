/**
 * The short form of a mission id, as every page and report shows it to an
 * operator: its LAST 8 characters. Mission ids are UUIDv7 (`store/ids.ts`):
 * their first characters are a timestamp, the same for missions made within
 * the same minute, while the last ones are random. Pure and browser-safe.
 */
export const SHORT_ID_LENGTH = 8;

export function shortId(id: string): string {
  return id.slice(-SHORT_ID_LENGTH);
}
