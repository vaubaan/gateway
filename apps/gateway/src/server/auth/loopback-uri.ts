/**
 * Where Vaubaan's installed-app clients come back (ADR
 * local-instance-carries-installed-oauth-clients): the loopback address, never `localhost`,
 * at the port of the public URL. Google, Microsoft and GitHub take any port there without
 * registering it, so the desktop app may answer on another port than 3100.
 */
export const LOOPBACK_PATH = '/oauth/loopback';

export function loopbackRedirectUri(publicUrl: URL): URL {
  const uri = new URL(`http://127.0.0.1${LOOPBACK_PATH}`);
  uri.port = publicUrl.port;
  return uri;
}
