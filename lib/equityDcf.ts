// Equity cash flow valuation for banks and insurers, following Koller,
// Goedhart & Wessels, "Valuation", Part 5 ("Valuing Banks").
//
// Why enterprise DCF cannot be used here. For an industrial company, debt is a
// financing choice: it sits outside the operating business, so free cash flow
// can be defined before financing and discounted at the WACC. For a bank, debt
// -- deposits and wholesale funding -- is raw material. Interest paid on
// deposits is an operating cost of the business, not a financing charge, and
// there is no meaningful line between operating and financing assets. Invested
// capital, NOPAT, free cash flow and the WACC therefore all lose their meaning.
//
// Koller's answer is to value equity directly:
//
//   1. Forecast net income and the book equity needed to support it. A bank's
//      growth is constrained by regulatory capital: to grow the balance sheet
//      by g, equity has to grow by g as well.
//   2. Equity cash flow is what is left for shareholders after that
//      reinvestment: ECF = net income - increase in book equity.
//   3. Discount equity cash flow at the cost of equity, not the WACC. The
//      result is the value of equity directly; there is no bridge, because
//      there is no enterprise value to bridge from.
//   4. Continuing value uses the key value driver formula in its equity form:
//
//         CV = NI(t+1) x (1 - g / ROE) / (Ke - g)
//
// The reinvestment rate g/ROE is the same identity as the enterprise model's
// g/RONIC, with return on equity in place of return on invested capital.
//
// Two conventions worth stating plainly, because they drive the answer:
//
//   - Discounting is end-of-year, not mid-year. Equity cash flow to a bank is
//     dominated by dividends and capital actions that fall at period ends, and
//     end-of-year discounting makes the model reconcile exactly to book value
//     in the competitive-equilibrium case, which is a useful audit.
//   - Terminal ROE defaults to the bank's own current return on equity: the
//     assumption is that it keeps earning what it earns today. The alternative
//     default, terminal ROE = cost of equity, is the competitive-equilibrium
//     assumption the enterprise model makes when it sets terminal RONIC equal
//     to the WACC (Ch. 12), and it is the more conservative reading of the
//     evidence on fading returns. It was rejected as a *default* here for a
//     practical reason: it is not neutral. When ROE equals the cost of equity
//     the model returns book equity exactly, so under that default every large
//     bank -- which is to say every bank earning above its cost of equity and
//     trading above book -- comes out "overvalued" without the reader ever
//     being shown that a bearish assumption was made on their behalf. The
//     equilibrium case remains available through `terminalReturnOnEquity`, and
//     the book-equity identity it produces is still the model's sharpest audit.

import { SensitivityGrid } from './types';

export interface EquityForecastYear {
  year: number;
  /** Book equity at the start of the year. */
  openingEquity: number;
  netIncome: number;
  returnOnEquity: number;
  /** Retained earnings needed to grow the capital base at g. */
  equityInvestment: number;
  /** Net income less the equity investment: what shareholders can take out. */
  equityCashFlow: number;
  discountFactor: number;
  presentValue: number;
}

export interface EquityDcfInputs {
  netIncome: number;
  /** Common book equity: total equity less any minority interest. */
  bookEquity: number;
  costOfEquity: number;
  /** Growth in the capital base during the explicit years. */
  growth: number;
  terminalGrowth: number;
  explicitYears: number;
  sharesOutstanding: number;
  sharePrice: number;
  /**
   * Optional override; defaults to the bank's current ROE. Set it to the cost
   * of equity for the Ch. 12 competitive-equilibrium case.
   */
  terminalReturnOnEquity?: number | null;
  /**
   * Reporting currency, used only to format the per-share figures quoted in the
   * warnings. The arithmetic is unit-agnostic; omit it and those print bare.
   */
  currency?: string;
}

export interface EquityDcfResult {
  costOfEquity: number;
  /** Current net income over current book equity. */
  returnOnEquity: number;
  terminalReturnOnEquity: number;
  growth: number;
  terminalGrowth: number;

  forecast: EquityForecastYear[];
  pvExplicitEquityCashFlow: number;
  continuingValue: number;
  pvContinuingValue: number;
  equityValue: number;
  fairValuePerShare: number;

  /** Equity value over book equity: the model's implied price-to-book. */
  impliedPriceToBook: number;
  marketPriceToBook: number;

  sensitivity: SensitivityGrid;
  marketPrice: number;
  valuationGapPct: number;
  verdict: 'undervalued' | 'overvalued' | 'fairly valued';
  warnings: string[];
}

/** Spread below which growth is not allowed to approach the discount rate. */
const MIN_SPREAD = 0.005;

/**
 * Per-share formatting for the warning text only. The UI has a richer formatter,
 * but a warning that reads "fair value falls to 11.88" beside a page where every
 * other figure carries a currency is a figure the reader has to guess at.
 */
function perShare(n: number, currency?: string): string {
  if (!isFinite(n)) return '—';
  if (!currency) return n.toFixed(2);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function core(i: EquityDcfInputs): {
  forecast: EquityForecastYear[];
  pvExplicit: number;
  continuingValue: number;
  pvContinuingValue: number;
  equityValue: number;
  terminalRoe: number;
} {
  const ke = i.costOfEquity;
  const roe = i.bookEquity > 0 ? i.netIncome / i.bookEquity : 0;
  const g = i.growth;
  // Growth at or above the discount rate makes the continuing value infinite
  // or negative, so it is capped rather than allowed to produce a number.
  const gT = Math.min(i.terminalGrowth, ke - MIN_SPREAD);
  // The bank is assumed to keep earning its current return. Where that return
  // is unusable the equilibrium assumption takes over: a loss year or negative
  // book equity gives a meaningless ROE, and a return at or below the terminal
  // growth rate implies the bank must retain everything it earns and more just
  // to stand still, which drives continuing value to zero or below.
  const currentRoeUsable = isFinite(roe) && roe > gT + MIN_SPREAD;
  const terminalRoe = i.terminalReturnOnEquity ?? (currentRoeUsable ? roe : ke);

  const forecast: EquityForecastYear[] = [];
  let equity = i.bookEquity;
  let pvExplicit = 0;
  for (let t = 1; t <= i.explicitYears; t++) {
    const openingEquity = equity;
    const netIncome = openingEquity * roe;
    const equityInvestment = openingEquity * g;
    const equityCashFlow = netIncome - equityInvestment;
    const discountFactor = 1 / Math.pow(1 + ke, t);
    const presentValue = equityCashFlow * discountFactor;
    forecast.push({
      year: t,
      openingEquity,
      netIncome,
      returnOnEquity: openingEquity > 0 ? netIncome / openingEquity : 0,
      equityInvestment,
      equityCashFlow,
      discountFactor,
      presentValue,
    });
    pvExplicit += presentValue;
    equity = openingEquity + equityInvestment;
  }

  // Continuing value: the first post-forecast year's net income, earned on the
  // closing capital base at the terminal return, less the share of it that has
  // to be retained to keep growing at gT.
  const netIncomeNext = equity * terminalRoe;
  const retention = terminalRoe > 0 ? gT / terminalRoe : 0;
  const continuingValue = (netIncomeNext * (1 - retention)) / (ke - gT);
  const pvContinuingValue = continuingValue / Math.pow(1 + ke, i.explicitYears);

  return {
    forecast,
    pvExplicit,
    continuingValue,
    pvContinuingValue,
    equityValue: pvExplicit + pvContinuingValue,
    terminalRoe,
  };
}

function fairValueAt(i: EquityDcfInputs, ke: number, gT: number): number {
  // Terminal ROE is inherited, not pinned to the cost of equity: the grid has
  // to vary only the two axes it names, or the centre cell would not equal the
  // headline value it is supposed to be a sensitivity around.
  const r = core({ ...i, costOfEquity: ke, terminalGrowth: gT });
  return i.sharesOutstanding > 0 ? r.equityValue / i.sharesOutstanding : NaN;
}

export function equityDcf(i: EquityDcfInputs): EquityDcfResult {
  const warnings: string[] = [];
  if (i.bookEquity <= 0) {
    warnings.push(
      'Book equity is zero or negative in the source data, so return on equity and the whole equity model are not computable. Nothing below can be relied on.'
    );
  }
  if (i.netIncome <= 0) {
    warnings.push(
      'Net income for the latest year is zero or negative. An equity cash flow model extrapolates from current earnings, so a loss year makes the forecast meaningless until the earnings base is normalized.'
    );
  }
  const roe = i.bookEquity > 0 ? i.netIncome / i.bookEquity : 0;
  if (i.growth > roe && roe > 0) {
    warnings.push(
      `Growth of ${(i.growth * 100).toFixed(1)}% exceeds the return on equity of ${(roe * 100).toFixed(1)}%, so the bank has to raise capital rather than pay it out and equity cash flow is negative through the forecast. Check whether the growth rate is really sustainable.`
    );
  }
  if (i.terminalGrowth >= i.costOfEquity - MIN_SPREAD) {
    warnings.push(
      `Long-run growth was capped just below the ${(i.costOfEquity * 100).toFixed(1)}% cost of equity; above it the continuing value formula breaks down.`
    );
  }

  const r = core(i);
  const fairValuePerShare = i.sharesOutstanding > 0 ? r.equityValue / i.sharesOutstanding : NaN;

  // The single largest assumption in the model, so it is stated rather than
  // buried in the exhibits: continuing value is the majority of the answer,
  // and it is driven by this rate.
  if (r.terminalRoe > i.costOfEquity + 1e-9 && i.sharesOutstanding > 0) {
    // Value the equilibrium case rather than describing it. It is not simply
    // book value: the explicit years still earn the current return, so book
    // equity plus those excess returns is the floor this comparison reports.
    const equilibrium = core({ ...i, terminalReturnOnEquity: i.costOfEquity }).equityValue / i.sharesOutstanding;
    warnings.push(
      `Continuing value assumes the bank goes on earning ${(r.terminalRoe * 100).toFixed(1)}% on equity forever, against a ${(i.costOfEquity * 100).toFixed(1)}% cost of equity — an assumption of durable competitive advantage, and the largest single assumption in this valuation. Let returns instead fade to the cost of equity after the forecast, which is what the enterprise model assumes for industrials, and fair value falls to ${perShare(equilibrium, i.currency)} per share against book equity of ${perShare(i.bookEquity / i.sharesOutstanding, i.currency)}.`
    );
  }

  const gT = Math.min(i.terminalGrowth, i.costOfEquity - MIN_SPREAD);
  const keValues = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => i.costOfEquity + d).filter((v) => v > 0.01);
  const growthValues = [-0.01, -0.005, 0, 0.005, 0.01].map((d) => gT + d);
  const sensitivity: SensitivityGrid = {
    waccValues: keValues,
    growthValues,
    fairValues: keValues.map((ke) => growthValues.map((g) => fairValueAt(i, ke, Math.min(g, ke - MIN_SPREAD)))),
    baseWacc: i.costOfEquity,
    baseGrowth: gT,
  };

  const gap = i.sharePrice > 0 ? (fairValuePerShare - i.sharePrice) / i.sharePrice : NaN;
  // Same 7.5% band as the enterprise engine, so the verdict badge means the
  // same thing whichever model produced it.
  const verdict = !isFinite(gap) || Math.abs(gap) <= 0.075 ? 'fairly valued' : gap > 0 ? 'undervalued' : 'overvalued';

  return {
    costOfEquity: i.costOfEquity,
    returnOnEquity: roe,
    terminalReturnOnEquity: r.terminalRoe,
    growth: i.growth,
    terminalGrowth: gT,
    forecast: r.forecast,
    pvExplicitEquityCashFlow: r.pvExplicit,
    continuingValue: r.continuingValue,
    pvContinuingValue: r.pvContinuingValue,
    equityValue: r.equityValue,
    fairValuePerShare,
    impliedPriceToBook: i.bookEquity > 0 ? r.equityValue / i.bookEquity : NaN,
    marketPriceToBook:
      i.bookEquity > 0 && i.sharesOutstanding > 0 ? (i.sharePrice * i.sharesOutstanding) / i.bookEquity : NaN,
    sensitivity,
    marketPrice: i.sharePrice,
    valuationGapPct: gap,
    verdict,
    warnings,
  };
}
