export interface ValuationSnapshot {
  ticker: string;
  valuationDate: string;
  informationCutoff: string;
  currency: string;
  marketPrice: number;
  fairValuePerShare: number;
  model: 'enterprise-dcf' | 'equity-dcf';
  source: 'saved-run' | 'imported-workbook';
}

export interface HistoricalSeries {
  ticker: string;
  currency: string;
  points: ValuationSnapshot[];
  warnings: string[];
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Reject look-ahead snapshots before they can reach a chart. */
export function validateSnapshot(snapshot: ValuationSnapshot): string[] {
  const errors: string[] = [];
  if (!snapshot.ticker.trim()) errors.push('ticker is required');
  if (!validDate(snapshot.valuationDate)) errors.push('valuationDate must be YYYY-MM-DD');
  if (!validDate(snapshot.informationCutoff)) errors.push('informationCutoff must be YYYY-MM-DD');
  if (validDate(snapshot.valuationDate) && validDate(snapshot.informationCutoff) && snapshot.informationCutoff > snapshot.valuationDate) {
    errors.push('informationCutoff cannot be later than valuationDate (look-ahead bias)');
  }
  if (!Number.isFinite(snapshot.marketPrice) || snapshot.marketPrice <= 0) errors.push('marketPrice must be positive');
  if (!Number.isFinite(snapshot.fairValuePerShare) || snapshot.fairValuePerShare <= 0) errors.push('fairValuePerShare must be positive');
  if (!snapshot.currency.trim()) errors.push('currency is required');
  return errors;
}

export function buildHistoricalSeries(ticker: string, snapshots: ValuationSnapshot[]): HistoricalSeries {
  const warnings: string[] = [];
  const validSnapshots: ValuationSnapshot[] = [];
  for (const snapshot of snapshots) {
    const errors = validateSnapshot(snapshot);
    if (errors.length > 0) warnings.push(`${snapshot.valuationDate || 'unknown date'}: ${errors.join('; ')}`);
    else if (snapshot.ticker.toUpperCase() === ticker.toUpperCase()) validSnapshots.push(snapshot);
  }
  validSnapshots.sort((a, b) => a.valuationDate.localeCompare(b.valuationDate));
  const currencies = new Set(validSnapshots.map((snapshot) => snapshot.currency));
  if (currencies.size > 1) warnings.push('Snapshots contain multiple currencies; normalize them before plotting one price axis.');
  return { ticker, currency: validSnapshots[0]?.currency ?? '', points: validSnapshots, warnings };
}
