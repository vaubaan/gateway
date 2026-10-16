import type { HTMLAttributes } from 'react';

export function Container({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={['vbn-container', rest.className ?? ''].join(' ')}>
      {children}
    </div>
  );
}

export function Stack({
  gap = 'var(--space-3)',
  children,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { gap?: string }) {
  return (
    <div {...rest} style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {children}
    </div>
  );
}
