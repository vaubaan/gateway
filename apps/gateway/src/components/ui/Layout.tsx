import type { CSSProperties, HTMLAttributes } from 'react';

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

export function Row({
  gap = 'var(--space-3)',
  align = 'center',
  children,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { gap?: string; align?: CSSProperties['alignItems'] }) {
  return (
    <div {...rest} style={{ display: 'flex', gap, alignItems: align, ...style }}>
      {children}
    </div>
  );
}

export function Spacer({ size = 'var(--space-4)' }: { size?: string }) {
  return <div style={{ height: size }} />;
}
