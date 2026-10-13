import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import styles from './Table.module.css';

export function Table(props: TableHTMLAttributes<HTMLTableElement>) {
  return <table {...props} className={[styles.table, props.className ?? ''].join(' ')} />;
}
export function Thead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={[styles.thead, props.className ?? ''].join(' ')} />;
}
export function Tbody(props: HTMLAttributes<HTMLTableSectionElement>) {
  // The class the hover rule of a row is written under (`.tbody .tr:hover`).
  return <tbody {...props} className={[styles.tbody, props.className ?? ''].join(' ')} />;
}
export function Tr(props: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} className={[styles.tr, props.className ?? ''].join(' ')} />;
}
export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} className={[styles.th, props.className ?? ''].join(' ')} />;
}
export function Td(props: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={[styles.td, props.className ?? ''].join(' ')} />;
}
