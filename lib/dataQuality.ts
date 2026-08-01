// Data-quality disclosure. Every number the valuation depends on is listed with
// the value used, where it came from, and a confidence tag, so nothing that was
// estimated or defaulted is buried in prose.
//
// Confidence levels:
//   source    - read directly from a filing or exchange feed
//   derived   - computed from source figures (a ratio, a sum, a CAGR)
//   estimated - inferred with a documented rule because the source lacked it
//   default   - a static assumption not specific to this company

import { BetaEstimate } from './beta';
import { StatementFacts } from './statements';
import { Confidence, DataQualityRow, DcfAssumptions, Financials } from './types';

export function fmtMoney(v: number, currency: string): string {
  const abs = Math.abs(v);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${currency} ${(v / scale).toFixed(2)}${suffix}`;
  }
  return `${currency} ${v.toFixed(2)}`;
}

export function fmtPct(v: number, dp = 1): string {
  return `${(v * 100).toFixed(dp)}%`;
}

export class QualityLog {
  private rows: DataQualityRow[] = [];

  add(field: string, value: string, basis: string, confidence: Confidence): void {
    this.rows.push({ field, value, basis, confidence });
  }

  /** Replaces an existing row for the same field, so later knowledge wins. */
  set(field: string, value: string, basis: string, confidence: Confidence): void {
    const i = this.rows.findIndex((r) => r.field === field);
    const row = { field, value, basis, confidence };
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
  }

  /** Rewrites only the value of an existing row, keeping its recorded basis. */
  setValue(field: string, value: string): void {
    const row = this.rows.find((r) => r.field === field);
    if (row) row.value = value;
  }

  all(): DataQualityRow[] {
    return this.rows;
  }
}

/**
 * Rows that can be inferred from the assembled inputs alone. Route-specific
 * provenance (which feed a price came from, whether a currency conversion was
 * applied) is added separately by the caller before this runs.
 */
export function appendDerivedRows(
  log: QualityLog,
  f: Financials,
  a: DcfAssumptions,
  facts: StatementFacts | null,
  wacc: number,
  betaEstimate: BetaEstimate | null = null,
  riskFreeProvenance?: { basis: string; confidence: Confidence }
): DataQualityRow[] {
  const c = f.currency;
  const src: Confidence = facts === null ? 'estimated' : 'source';
  const from = facts?.source === 'edgar' ? 'SEC EDGAR XBRL' : 'stockanalysis.com statements';

  log.set('Revenue', fmtMoney(f.revenue, c), `${from}, latest fiscal year`, src);
  log.set('EBIT (operating income)', fmtMoney(f.ebit, c), `${from}, after the Part 3 adjustments below`, src);
  log.set('Invested capital', fmtMoney(f.investedCapital, c), 'built from the balance sheet (Ch. 9); see the reorganization panel', src);
  log.set('Total debt', fmtMoney(f.totalDebt, c), `${from}, short plus long term`, src);
  log.set('Debt equivalents', fmtMoney(f.debtEquivalents, c), 'operating leases and unfunded pensions (Ch. 19/20)', f.debtEquivalents > 0 ? 'derived' : 'source');
  log.set('Operating cash', fmtMoney(f.operatingCash, c), '2% of revenue, the cash needed to run the business (Ch. 14)', 'estimated');
  log.set(
    'Excess cash',
    fmtMoney(f.excessCash, c),
    'cash above the operating need, plus short-term investments; the cash and equivalents row above says which balance sheet the cash came from',
    'derived'
  );
  log.set('Nonoperating assets', fmtMoney(f.nonoperatingAssets, c), 'long-term and equity-method investments (Ch. 19)', f.nonoperatingAssets > 0 ? 'source' : 'derived');
  log.set('Minority interest', fmtMoney(f.minorityInterest, c), from, src);
  log.set(
    'Shares outstanding',
    Math.round(f.sharesOutstanding).toLocaleString('en-US'),
    'latest reported count; multi-class structures may understate the total',
    src
  );

  log.set('Operating tax rate', fmtPct(a.taxRate), 'tax provision adjusted for the interest tax shield (Ch. 18)', 'derived');
  log.set(
    'Revenue growth, stage 1',
    fmtPct(a.stage1RevenueGrowth),
    f.revenueCagr3y === null ? 'no usable revenue history; 4% default applied' : 'historical 3-year revenue CAGR',
    f.revenueCagr3y === null ? 'default' : 'derived'
  );
  log.set('Terminal growth', fmtPct(a.terminalGrowth), 'long-run nominal growth assumption (Ch. 12)', 'default');
  log.set(
    'Incremental ROIC, stage 1',
    fmtPct(a.stage1IncrementalRoic),
    'current NOPAT over invested capital, capped at 40%',
    'derived'
  );
  log.set('Terminal RONIC', fmtPct(a.terminalIncrementalRoic), "set equal to the WACC, Ch. 12's competitive-equilibrium default", 'default');

  log.set(
    'Risk-free rate used',
    fmtPct(a.riskFreeRate),
    riskFreeProvenance?.basis ?? `${f.marketName} 10-year government bond yield; same-currency rate used to discount the cash flows (Ch. 13)`,
    riskFreeProvenance?.confidence ?? 'source'
  );
  log.set('Equity risk premium', fmtPct(a.equityRiskPremium), 'mature-market premium; Koller Ch. 13 argues for a 5-6% range', 'default');
  if (a.countryRiskPremium > 0) {
    log.set('Country risk premium', fmtPct(a.countryRiskPremium), `additive premium for ${f.marketName} as a less-integrated market (Part 5)`, 'default');
  }
  log.set(
    'Beta',
    a.beta.toFixed(2),
    betaEstimate === null ? 'no derivation recorded' : betaEstimate.basis,
    betaEstimate === null ? 'default' : betaEstimate.confidence
  );
  if (betaEstimate !== null) {
    log.set(
      'Unlevered beta',
      betaEstimate.unleveredBeta.toFixed(2),
      `business risk with capital structure stripped out, at a debt-to-equity of ${betaEstimate.debtToEquity.toFixed(2)} and an assumed beta of debt of zero (Ch. 15)`,
      betaEstimate.confidence
    );
  }
  log.set('WACC', fmtPct(wacc), 'market-value weighted cost of equity and after-tax cost of debt (Ch. 13)', 'derived');

  return log.all();
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  source: 'From filing',
  derived: 'Calculated',
  estimated: 'Estimated',
  default: 'Assumption',
};
