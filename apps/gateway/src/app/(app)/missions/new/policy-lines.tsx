/**
 * How a permission's rate limit reads on the mission screen ("10 a minute").
 */
import { formatNumber } from '@/lib/vocabulary';

export function ratePhrase(max: string, window: string): string {
  if (max.trim() === '') return 'no limit yet';
  const n = formatNumber(Number(max));
  return window === '60' ? `${n} a minute` : `${n} per ${window} s`;
}
