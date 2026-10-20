/**
 * The services an account can be connected to, as a grid of choices: the
 * mark, the name, and how the account is connected in a few words. The list is
 * the plugin registry's (`ConnectionService.providers()`); nothing is
 * enumerated here.
 *
 * A service whose OAuth client is not declared yet is still listed, dashed,
 * with what is missing: an administrator is led to its connect page, where
 * the client is declared; anyone else reads who to ask.
 */
import { PickCard, PickGrid, ServiceMark } from '@/components/ui';
import { ACCOUNT_WORDS } from '@/lib/vocabulary';
import {
  connectPagePath,
  NEW_CONNECTION_PATH,
  type ConnectableProvider,
} from '@/server/connections';

/** "Access token" → "access token"; "API key" stays: an acronym keeps its capitals. */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** How the account is connected, in the words of the service where it has some. */
export function howToConnect(provider: ConnectableProvider): string {
  switch (provider.kind) {
    case 'oauth2':
      return `sign in at ${provider.displayName}`;
    case 'ssh-key':
      return 'a key pair made here, installed on the host';
    case 'api-key': {
      const labels = provider.fields.map((field) => lowerFirst(field.label));
      return labels.length === 0 ? 'a key you paste' : `paste: ${labels.join(' and ')}`;
    }
  }
}

export function ServicePicker({
  providers,
  administrator,
  returnTo = null,
}: {
  providers: readonly ConnectableProvider[];
  /** An administrator can declare the OAuth client a service misses. */
  administrator: boolean;
  /** Where to land after connecting (the mission being written). */
  returnTo?: string | null;
}) {
  const suffix = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
  // What can be connected now first; the registry's order inside each half.
  const ordered = [
    ...providers.filter((provider) => provider.configured),
    ...providers.filter((provider) => !provider.configured),
  ];
  return (
    <PickGrid label="Services" testId="service-picker">
      {ordered.map((provider) => {
        const lead = <ServiceMark name={provider.displayName} />;
        if (!provider.configured) {
          return (
            <PickCard
              key={provider.id}
              unavailable
              href={administrator ? connectPagePath(provider.id) : undefined}
              lead={lead}
              title={provider.displayName}
              description={
                administrator
                  ? 'needs its OAuth client · declare it'
                  : 'needs its OAuth client · ask an administrator'
              }
              testId={`service-${provider.id}`}
            />
          );
        }
        return (
          <PickCard
            key={provider.id}
            href={`${NEW_CONNECTION_PATH}/${encodeURIComponent(provider.id)}${suffix}`}
            lead={lead}
            title={provider.displayName}
            description={
              provider.experimental
                ? `${howToConnect(provider)} · ${ACCOUNT_WORDS.experimental}`
                : howToConnect(provider)
            }
            testId={`service-${provider.id}`}
          />
        );
      })}
    </PickGrid>
  );
}
