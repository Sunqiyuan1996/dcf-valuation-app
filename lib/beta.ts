// Beta, following Koller, Goedhart & Wessels, "Valuation", Part 2 Ch. 15
// ("Estimating the Cost of Capital").
//
// Koller's argument, in order:
//
//  1. A raw beta from regressing the company's own returns on a market index
//     is noisy. The book's specification is 60 months of monthly returns
//     against a value-weighted, well-diversified index.
//  2. Raw regression betas are biased away from 1.0 by estimation error, so
//     they are smoothed toward the market: adjusted = 0.33 + 0.67 x raw
//     (the Bloomberg/Blume adjustment).
//  3. Better still, use an industry beta. Unlever each peer's beta to strip out
//     its capital structure, average across the industry -- which cancels most
//     of the remaining regression error -- then relever at the company's own
//     capital structure. An industry beta needs no further smoothing, because
//     the averaging has already done that job.
//
// Unlevering assumes the beta of debt is zero and that the interest tax shield
// carries the same risk as the operating assets, which is Koller's
// recommendation and gives the tax-free form:
//
//     beta_unlevered = beta_equity / (1 + D/E)
//
// What this file can and cannot do with the free data sources wired up here:
// no price-history feed is available, so step 1 is not currently computable.
// `estimateBeta` therefore runs steps 3 and 2 in reverse priority -- it starts
// from a market-wide unlevered beta and relevers it at the company's own
// market-value D/E. That is a real, disclosed estimate rather than the flat
// 1.0 it replaces. If a regression beta ever becomes available, pass it in as
// `rawRegressionBeta` and the smoothing path takes over.

import { Confidence } from './types';

/**
 * The market portfolio's levered beta is 1.0 by construction, and the average
 * listed company carries debt, so the market's *unlevered* beta is below 1.
 * At a typical market debt-to-equity of one third this works out to exactly
 * 0.75, which is the anchor used when no industry peer set is available.
 */
export const MARKET_DEBT_TO_EQUITY = 1 / 3;
export const MARKET_UNLEVERED_BETA = 1 / (1 + MARKET_DEBT_TO_EQUITY);

/** Relevered betas outside this range come from a distorted D/E, not from risk. */
const MIN_BETA = 0.4;
const MAX_BETA = 2.5;

export interface BetaEstimate {
  /** The levered (equity) beta to use in the CAPM. */
  beta: number;
  /** The unlevered beta it was built from. */
  unleveredBeta: number;
  /** Market-value debt to equity used for relevering. */
  debtToEquity: number;
  /** Human-readable derivation for the data-quality panel. */
  basis: string;
  confidence: Confidence;
  /** True when the result hit MIN_BETA or MAX_BETA. */
  clamped: boolean;
}

/** Bloomberg/Blume smoothing. Only valid on a raw regression beta (Ch. 15). */
export function smoothRawBeta(raw: number): number {
  return 0.33 + 0.67 * raw;
}

/** Strip out capital structure, assuming beta of debt is zero (Ch. 15). */
export function unlever(leveredBeta: number, debtToEquity: number): number {
  return leveredBeta / (1 + debtToEquity);
}

/** Apply a capital structure back onto an unlevered beta (Ch. 15). */
export function relever(unleveredBeta: number, debtToEquity: number): number {
  return unleveredBeta * (1 + debtToEquity);
}

function clamp(v: number): { value: number; clamped: boolean } {
  if (v < MIN_BETA) return { value: MIN_BETA, clamped: true };
  if (v > MAX_BETA) return { value: MAX_BETA, clamped: true };
  return { value: v, clamped: false };
}

export function estimateBeta(opts: {
  /** A 60-month regression beta, if one is ever available. */
  rawRegressionBeta?: number | null;
  /** Market value of equity, in the reporting currency. */
  marketCap: number | null;
  /** Total debt plus debt equivalents (capitalized leases, unfunded pensions). */
  debtIncludingEquivalents: number;
  /** Banks and insurers: unlevering and relevering do not apply (Part 5). */
  isFinancial?: boolean;
}): BetaEstimate {
  const equity = opts.marketCap !== null && opts.marketCap > 0 ? opts.marketCap : null;
  const debt = Math.max(opts.debtIncludingEquivalents, 0);
  const debtToEquity = equity === null ? MARKET_DEBT_TO_EQUITY : debt / equity;

  const raw = opts.rawRegressionBeta;

  // A bank's leverage is not a financing choice. Deposits and wholesale funding
  // are the raw material of the business, so the D/E ratio above is not a
  // capital structure that can be stripped out and put back: relevering the
  // market anchor at a bank's D/E of five or ten would return a beta of three
  // or more, which is an artifact of the formula rather than a statement about
  // risk. Bank equity betas sit near the market. So the levered beta is used
  // directly and no relevering is attempted (Part 5).
  if (opts.isFinancial === true) {
    const levered = raw !== null && raw !== undefined && isFinite(raw) && raw > 0 ? smoothRawBeta(raw) : 1.0;
    const c = clamp(levered);
    return {
      beta: c.value,
      unleveredBeta: c.value,
      debtToEquity,
      basis:
        raw !== null && raw !== undefined && isFinite(raw) && raw > 0
          ? `regression beta of ${raw.toFixed(2)} smoothed as 0.33 + 0.67 x raw and used as a levered beta. ` +
            `For a bank or insurer, deposits and funding are operating liabilities rather than a financing choice, so Ch. 15's unlever-and-relever route is deliberately not applied (Part 5)`
          : `the market's levered beta of 1.0 is used directly. For a bank or insurer, deposits and funding are the raw material of the business rather than a financing choice, ` +
            `so unlevering and relevering do not apply: at this company's debt-to-equity of ${debtToEquity.toFixed(2)}, relevering would return a beta of about ${relever(MARKET_UNLEVERED_BETA, debtToEquity).toFixed(1)}, ` +
            `which measures the formula rather than the risk (Part 5). A published regression beta would be a real improvement here`,
      confidence: 'estimated',
      clamped: c.clamped,
    };
  }

  if (raw !== null && raw !== undefined && isFinite(raw) && raw > 0) {
    const smoothed = smoothRawBeta(raw);
    const c = clamp(smoothed);
    return {
      beta: c.value,
      unleveredBeta: unlever(c.value, debtToEquity),
      debtToEquity,
      basis:
        `regression beta of ${raw.toFixed(2)} smoothed toward the market as 0.33 + 0.67 x raw, ` +
        `the Bloomberg adjustment Koller recommends for the estimation error in a single-company regression (Ch. 15)`,
      confidence: 'derived',
      clamped: c.clamped,
    };
  }

  const relevered = relever(MARKET_UNLEVERED_BETA, debtToEquity);
  const c = clamp(relevered);
  const leverageNote =
    equity === null
      ? `no market capitalization was available, so the market's own debt-to-equity of ${MARKET_DEBT_TO_EQUITY.toFixed(2)} was assumed`
      : `relevered at this company's market-value debt-to-equity of ${debtToEquity.toFixed(2)} (debt and debt equivalents over market capitalization)`;
  return {
    beta: c.value,
    unleveredBeta: MARKET_UNLEVERED_BETA,
    debtToEquity,
    basis:
      `no return history is available for a 60-month regression, so Ch. 15's unlever-and-relever route is used from the market anchor: ` +
      `the market portfolio's levered beta is 1.0 by definition, which unlevers to ${MARKET_UNLEVERED_BETA.toFixed(2)} at a typical market debt-to-equity of ${MARKET_DEBT_TO_EQUITY.toFixed(2)}, ` +
      `then ${leverageNote}. This captures the company's financial risk but not its business risk, which an industry peer set would add` +
      (c.clamped ? `. The result was capped at ${c.value.toFixed(2)}, so the leverage figure above is worth checking` : ''),
    confidence: 'estimated',
    clamped: c.clamped,
  };
}
