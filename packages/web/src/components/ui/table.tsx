'use client';

import { createContext, useContext } from 'react';
import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

import { cn } from './cn';

export type TableDensity = 'comfortable' | 'default' | 'compact';

const DensityCtx = createContext<TableDensity>('default');

const DENSITY_CELL: Record<TableDensity, string> = {
  comfortable: 'px-4 py-3',
  default: 'px-3 py-2',
  compact: 'px-2 py-1',
};

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  readonly density?: TableDensity;
}

export function Table({ density = 'default', className, children, ...rest }: TableProps) {
  return (
    <DensityCtx.Provider value={density}>
      <table
        data-density={density}
        className={cn('w-full border-collapse text-sm text-foreground', className)}
        {...rest}
      >
        {children}
      </table>
    </DensityCtx.Provider>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'text-left text-[11px] uppercase tracking-wide text-muted',
        '[&_th]:border-b [&_th]:border-border-default [&_th]:font-medium',
        className,
      )}
      {...rest}
    />
  );
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn('[&_tr]:border-b [&_tr]:border-border-default last:[&_tr]:border-0', className)}
      {...rest}
    />
  );
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('hover:bg-sunken', className)} {...rest} />;
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  const density = useContext(DensityCtx);
  return <th className={cn(DENSITY_CELL[density], 'text-left', className)} {...rest} />;
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  const density = useContext(DensityCtx);
  return <td className={cn(DENSITY_CELL[density], 'align-middle', className)} {...rest} />;
}
