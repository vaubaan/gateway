/**
 * Structured data for search engines and assistants (website spec §2.6).
 * The JSON is the site's own data, serialized here; every `<` is escaped so
 * nothing in it can close the script element.
 */
export function JsonLd({ data }: { readonly data: Readonly<Record<string, unknown>> }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    <script
      type="application/ld+json"
      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- the site's own data, serialized by JSON.stringify with every < escaped
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
