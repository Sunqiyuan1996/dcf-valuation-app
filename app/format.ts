// Shared formatters. Figures come back in the statement currency, not always
// USD, so every formatter takes the currency from the payload.

export function money(n: number, currency: string, compact = true): string {
  if (!Number.isFinite(n)) return '—';
  const opts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  };
  try {
    return new Intl.NumberFormat('en-US', opts).format(n);
  } catch {
    // Unknown ISO code: fall back to a plain number with the code prefixed.
    return `${currency} ${new Intl.NumberFormat('en-US', {
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 2,
    }).format(n)}`;
  }
}

export const fmtPct = (n: number, digits = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—');
export const fmtSignedPct = (n: number, digits = 1) =>
  Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%` : '—';
export const fmtX = (n: number, digits = 1) => (Number.isFinite(n) ? `${n.toFixed(digits)}x` : '—');
export const count = (n: number) => (Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '—');

/** Palette shared by the SVG exhibits and the Tailwind tokens in the config. */
export const C = {
  ink: '#0f172a',
  slate: '#64748b',
  line: '#e2e8f0',
  grid: '#f1f5f9',
  accent: '#0e7490',
  accentSoft: '#cffafe',
  positive: '#047857',
  positiveSoft: '#d1fae5',
  negative: '#b91c1c',
  negativeSoft: '#fee2e2',
  warn: '#b45309',
  warnSoft: '#fef3c7',
  neutral: '#94a3b8',
  neutralSoft: '#e2e8f0',
} as const;
