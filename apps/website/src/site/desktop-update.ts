/**
 * `/desktop/latest.json`: where the desktop app reads its update manifest (ADR
 * desktop-app-updated-by-the-tauri-updater-from-the-github-release; website spec §2.4 bis).
 * A temporary redirect to the `latest.json` attached to the GitHub release of the released
 * gateway (`releases.json`, written by the release preparation): GitHub's own
 * `releases/latest` address never names a pre-release. Temporary, so the next release moves
 * it. Until the release job has attached the file the redirect ends on a 404, which the app
 * takes as "nothing new".
 */
import { GITHUB_REPO } from './constants';

export const DESKTOP_UPDATE_PATH = '/desktop/latest.json';

export interface DesktopUpdateRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: false;
}

/** The redirect for the released gateway `version` (as `releases.json` names it). */
export function desktopUpdateRedirect(version: string): DesktopUpdateRedirect {
  if (!/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(version)) {
    throw new Error(`releases.json names "${version}", not a release version`);
  }
  return {
    source: DESKTOP_UPDATE_PATH,
    destination: `${GITHUB_REPO}/releases/download/v${version}/latest.json`,
    permanent: false,
  };
}
