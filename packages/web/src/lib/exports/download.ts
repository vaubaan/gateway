/**
 * Browser-side download trigger : Blob + URL.createObjectURL + <a download>.
 *
 * Phase 7 spec §6.7. The CRM Core never serves cleartext — the browser
 * assembles the file locally, wraps it in a `Blob`, and triggers a
 * download via a transient `<a href download>`. The Blob URL is
 * revoked immediately after the click so the cleartext is freed from
 * the URL store (defense in depth — the user's filesystem still has
 * the file).
 */

export function triggerBrowserDownload(
  filename: string,
  content: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
