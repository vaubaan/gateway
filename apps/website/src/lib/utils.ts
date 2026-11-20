/**
 * shadcn/ui's class helper: joins class names and lets a later Tailwind
 * utility override an earlier one of the same property.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
