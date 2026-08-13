import { AccountingFramework } from './types';

export type ComparableMetric = 'evToEbit' | 'evToRevenue' | 'pe' | 'priceToBook';

export interface ComparableCompany {
  ticker: string;
  companyName: string;
  industry: string;
  currency: string;
  marketCap: number;
  enterpriseValue: number;
  ebit: number | null;
  revenue: number | null;
  netIncome: number | null;
  bookEquity: number | null;
  sharePrice: number | null;
  sharesOutstanding: number | null;
  isFinancial: boolean;
  accountingFramework: AccountingFramework;
  asOf: string;
  source: string;
}

export interface ComparableObservation {
  ticker: string;
  companyName: string;
  industry: string;
  currency: string;
  isFinancial: boolean;
  asOf: string;
  source: string;
  multiples: Partial<Record<ComparableMetric, number>>;
  excluded: string[];
}

export interface ComparableSummary {
  metric: ComparableMetric;
  sampleSize: number;
  minimum: number | null;
  lowerQuartile: number | null;
  median: number | null;
  upperQuartile: number | null;
  maximum: number | null;
  targetMultiple: number | null;
  impliedEnterpriseValue: number | null;
  impliedEquityValue: number | null;
  impliedValuePerShare: number | null;
}

export interface ComparableAnalysis {
  target: { ticker: string; companyName: string; currency: string; isFinancial: boolean };
  peers: ComparableObservation[];
  summaries: ComparableSummary[];
  includedPeerCount: number;
  excludedPeerCount: number;
  status: 'complete' | 'partial' | 'unresolved';
  warnings: string[];
}

function valid(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

function observation(peer: ComparableCompany): ComparableObservation {
  const multiples: Partial<Record<ComparableMetric, number>> = {};
  const excluded: string[] = [];
  if (valid(peer.enterpriseValue) && valid(peer.ebit)) multiples.evToEbit = peer.enterpriseValue / peer.ebit;
  else excluded.push('EV/EBIT');
  if (valid(peer.enterpriseValue) && valid(peer.revenue)) multiples.evToRevenue = peer.enterpriseValue / peer.revenue;
  else excluded.push('EV/Revenue');
  if (valid(peer.marketCap) && valid(peer.netIncome)) multiples.pe = peer.marketCap / peer.netIncome;
  else excluded.push('P/E');
  if (valid(peer.marketCap) && valid(peer.bookEquity)) multiples.priceToBook = peer.marketCap / peer.bookEquity;
  else excluded.push('P/B');
  return {
    ticker: peer.ticker,
    companyName: peer.companyName,
    industry: peer.industry,
    currency: peer.currency,
    isFinancial: peer.isFinancial,
    asOf: peer.asOf,
    source: peer.source,
    multiples,
    excluded,
  };
}

function summary(
  metric: ComparableMetric,
  observations: ComparableObservation[],
  target: ComparableCompany
): ComparableSummary {
  const values = observations
    .map((peer) => peer.multiples[metric])
    .filter((value): value is number => valid(value));
  const selected = median(values);
  let impliedEnterpriseValue: number | null = null;
  let impliedEquityValue: number | null = null;
  let impliedValuePerShare: number | null = null;
  if (selected !== null) {
    if (metric === 'evToEbit' && valid(target.ebit)) impliedEnterpriseValue = selected * target.ebit;
    if (metric === 'evToRevenue' && valid(target.revenue)) impliedEnterpriseValue = selected * target.revenue;
    if (metric === 'pe' && valid(target.netIncome)) impliedEquityValue = selected * target.netIncome;
    if (metric === 'priceToBook' && valid(target.bookEquity)) impliedEquityValue = selected * target.bookEquity;
    if (impliedEnterpriseValue !== null) {
      impliedEquityValue = impliedEnterpriseValue - (target.enterpriseValue - target.marketCap);
    }
    if (impliedEquityValue !== null && valid(target.sharesOutstanding)) {
      impliedValuePerShare = impliedEquityValue / target.sharesOutstanding;
    }
  }
  return {
    metric,
    sampleSize: values.length,
    minimum: values.length ? Math.min(...values) : null,
    lowerQuartile: quantile(values, 0.25),
    median: selected,
    upperQuartile: quantile(values, 0.75),
    maximum: values.length ? Math.max(...values) : null,
    targetMultiple: selected,
    impliedEnterpriseValue,
    impliedEquityValue,
    impliedValuePerShare,
  };
}

/**
 * Build a transparent peer-multiple analysis. Multiples are only calculated
 * from positive denominators; excluded fields stay visible on each peer.
 */
export function analyzeComparables(target: ComparableCompany, peers: ComparableCompany[]): ComparableAnalysis {
  const warnings: string[] = [];
  const observations = peers.map(observation);
  const compatible = peers.filter((peer) => peer.isFinancial === target.isFinancial);
  if (compatible.length !== peers.length) warnings.push('Peers with a different financial/industrial model were excluded.');
  const usable = compatible.filter((peer) => peer.ticker !== target.ticker);
  if (usable.length === 0) warnings.push('No compatible peers were supplied.');
  if (usable.some((peer) => peer.accountingFramework === 'unknown')) warnings.push('At least one peer has an unknown accounting framework; compare its multiples with caution.');
  const usableObservations = usable.map(observation);
  const summaries = (['evToEbit', 'evToRevenue', 'pe', 'priceToBook'] as ComparableMetric[]).map((metric) => summary(metric, usableObservations, target));
  const includedPeerCount = usableObservations.filter((peer) => Object.keys(peer.multiples).length > 0).length;
  const status = includedPeerCount === 0 ? 'unresolved' : includedPeerCount < 3 ? 'partial' : 'complete';
  if (includedPeerCount < 3) warnings.push('Fewer than three compatible peers have usable multiples; the range is indicative only.');
  return {
    target: { ticker: target.ticker, companyName: target.companyName, currency: target.currency, isFinancial: target.isFinancial },
    peers: observations,
    summaries,
    includedPeerCount,
    excludedPeerCount: peers.length - includedPeerCount,
    status,
    warnings,
  };
}
