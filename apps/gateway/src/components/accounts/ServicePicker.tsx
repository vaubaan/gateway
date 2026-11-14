/**
 * The services an account can be connected to, as a grid of choices: the
 * mark, the name, and how the account is connected in a few words. The list is
 * the plugin registry's (`AccountService.providers()`); nothing is
 * enumerated here. A service waits for no administrator, except one connected
 * through an OAuth broker none is configured for: it says it is not configured.
 */
import { PickCard, PickGrid, ServiceMark } from '@/components/ui';
import { ACCOUNT_WORDS } from '@/lib/vocabulary';
import { NEW_ACCOUNT_PATH, type ConnectableProvider } from '@/server/accounts';

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
    case 'host':
      return 'one click, nothing to paste';
  }
}

export function ServicePicker({
  providers,
  returnTo = null,
}: {
  providers: readonly ConnectableProvider[];
  /** Where to land after connecting (the mission being written). */
  returnTo?: string | null;
}) {
  const suffix = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
  return (
    <PickGrid label="Services" testId="service-picker">
      {providers.map((provider) => (
        <PickCard
          key={provider.id}
          href={`${NEW_ACCOUNT_PATH}/${encodeURIComponent(provider.id)}${suffix}`}
          lead={<ServiceMark name={provider.displayName} icon={provider.icon} />}
          title={provider.displayName}
          description={
            provider.unavailable !== null
              ? `${howToConnect(provider)} · ${ACCOUNT_WORDS.notConfigured}`
              : howToConnect(provider)
          }
          testId={`service-${provider.id}`}
        />
      ))}
    </PickGrid>
  );
}
