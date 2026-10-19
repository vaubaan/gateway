'use client';

/**
 * The bootstrap token field of `/admin/bootstrap`, filled from the setup link
 * when the address carries one (`#token=…`, or `?token=…`): the operator lands
 * with the field ready and clicks. The token is then taken out of the address
 * bar, so that a reload, a bookmark or a shared screenshot of the address
 * does not keep it. The field stays editable; nothing is submitted here.
 */
import { useEffect, useState } from 'react';

import { Input } from '@/components/ui';

import { setupLinkWithoutToken, tokenFromSetupLink } from './setup-link';

export function BootstrapTokenInput({ id, name }: { id: string; name: string }) {
  const [value, setValue] = useState('');
  const [fromLink, setFromLink] = useState(false);

  useEffect(() => {
    const token = tokenFromSetupLink(window.location.href);
    if (!token) return;
    setValue(token);
    setFromLink(true);
    window.history.replaceState(
      window.history.state,
      '',
      setupLinkWithoutToken(window.location.href),
    );
  }, []);

  return (
    <Input
      id={id}
      type="password"
      name={name}
      required
      autoComplete="off"
      minLength={32}
      mono
      value={value}
      onChange={(event) => setValue(event.target.value)}
      data-from-link={fromLink ? 'true' : undefined}
    />
  );
}
