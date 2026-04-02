/**
 * Number, time, and size formatting utilities
 */

/** Format a number with comma-separated thousands: 15586 → "15,586" */
export function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(',');
}

/** Format number with commas, preserving one decimal for fractional values */
export function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? '-' : '') + commas(int) + frac;
  }
  return commas(n);
}

/** Format a number with optional unit */
export function formatNum(value: number | null, unit: string): string {
  if (value === null) return '—';
  const u = unit || '';
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
