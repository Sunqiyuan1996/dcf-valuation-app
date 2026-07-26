// Cost of capital, following Koller, Goedhart & Wessels, "Valuation":
//   Ch. 13 "Estimating the Cost of Capital" -- CAPM cost of equity, cost of
//     debt from the actual interest burden, market-value capital weights, and
//     a risk-free rate denominated in the same currency as the cash flows.
//   Part 5 "Emerging Markets" -- an additive country risk premium where the
//     sovereign and currency risk is not already diversified away.
//
// Koller's rule for cross-border valuation: discount cash flows stated in
// currency X at a WACC built from currency X's risk-free rate. Differences in
// nominal government bond yields largely reflect expected inflation
// differentials, so the local risk-free rate here is the live US 10-year
// Treasury yield (from FRED) plus a static per-market spread.
//
// IMPORTANT: the spreads and premiums below are approximations for defaulting
// purposes only. They are surfaced in the data-quality panel as "default" and
// every one of them is editable in the UI before recalculating.

export interface MarketParams {
  name: string;
  currency: string;
  /** Added to the US 10-year yield to approximate the local risk-free rate. */
  riskFreeSpread: number;
  /** Mature-market equity risk premium (Koller argues for a 5-6% range). */
  equityRiskPremium: number;
  /** Additive country risk premium for less-integrated markets. */
  countryRiskPremium: number;
  emerging: boolean;
}

const MATURE_ERP = 0.055;

/**
 * Keyed by the ticker suffix used in EXCHANGES (globalData.ts), plus 'US'.
 * Spreads are relative to the US 10-year: negative for markets whose nominal
 * government yields sit below Treasuries (JPY, CHF, EUR core, CNY).
 */
export const MARKETS: Record<string, MarketParams> = {
  US: { name: 'United States', currency: 'USD', riskFreeSpread: 0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },

  // Eurozone: core vs periphery split on sovereign spread only.
  DE: { name: 'Germany', currency: 'EUR', riskFreeSpread: -0.02, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  AS: { name: 'Netherlands', currency: 'EUR', riskFreeSpread: -0.018, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  PA: { name: 'France', currency: 'EUR', riskFreeSpread: -0.013, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  BR: { name: 'Belgium', currency: 'EUR', riskFreeSpread: -0.013, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  AT: { name: 'Greece', currency: 'EUR', riskFreeSpread: -0.005, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.005, emerging: false },
  VI: { name: 'Austria', currency: 'EUR', riskFreeSpread: -0.015, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  HE: { name: 'Finland', currency: 'EUR', riskFreeSpread: -0.015, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  IR: { name: 'Ireland', currency: 'EUR', riskFreeSpread: -0.015, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  MI: { name: 'Italy', currency: 'EUR', riskFreeSpread: -0.005, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  MC: { name: 'Spain', currency: 'EUR', riskFreeSpread: -0.01, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  LS: { name: 'Portugal', currency: 'EUR', riskFreeSpread: -0.012, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },

  UK: { name: 'United Kingdom', currency: 'GBP', riskFreeSpread: 0.0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  L: { name: 'United Kingdom', currency: 'GBP', riskFreeSpread: 0.0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  SW: { name: 'Switzerland', currency: 'CHF', riskFreeSpread: -0.035, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  JP: { name: 'Japan', currency: 'JPY', riskFreeSpread: -0.028, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  T: { name: 'Japan', currency: 'JPY', riskFreeSpread: -0.028, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },

  ST: { name: 'Sweden', currency: 'SEK', riskFreeSpread: -0.018, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  CO: { name: 'Denmark', currency: 'DKK', riskFreeSpread: -0.018, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  OL: { name: 'Norway', currency: 'NOK', riskFreeSpread: -0.005, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  IC: { name: 'Iceland', currency: 'ISK', riskFreeSpread: 0.025, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.005, emerging: false },

  TO: { name: 'Canada', currency: 'CAD', riskFreeSpread: -0.008, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  V: { name: 'Canada', currency: 'CAD', riskFreeSpread: -0.008, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  AX: { name: 'Australia', currency: 'AUD', riskFreeSpread: 0.0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  NZ: { name: 'New Zealand', currency: 'NZD', riskFreeSpread: 0.003, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },

  KS: { name: 'Korea', currency: 'KRW', riskFreeSpread: -0.013, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  KQ: { name: 'Korea', currency: 'KRW', riskFreeSpread: -0.013, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },
  TA: { name: 'Israel', currency: 'ILS', riskFreeSpread: 0.0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0, emerging: false },

  // Emerging / converging markets: country risk premium applied on top.
  HK: { name: 'Hong Kong / China H', currency: 'HKD', riskFreeSpread: -0.025, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.01, emerging: true },
  SS: { name: 'China A (Shanghai)', currency: 'CNY', riskFreeSpread: -0.025, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.01, emerging: true },
  SH: { name: 'China A (Shanghai)', currency: 'CNY', riskFreeSpread: -0.025, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.01, emerging: true },
  SZ: { name: 'China A (Shenzhen)', currency: 'CNY', riskFreeSpread: -0.025, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.01, emerging: true },
  WA: { name: 'Poland', currency: 'PLN', riskFreeSpread: 0.013, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.01, emerging: true },
  PR: { name: 'Czechia', currency: 'CZK', riskFreeSpread: 0.0, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.008, emerging: true },
  BU: { name: 'Hungary', currency: 'HUF', riskFreeSpread: 0.022, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.015, emerging: true },
  IS: { name: 'Turkey', currency: 'TRY', riskFreeSpread: 0.2, equityRiskPremium: MATURE_ERP, countryRiskPremium: 0.03, emerging: true },
};

export function marketParams(suffix: string | null): MarketParams {
  if (!suffix) return MARKETS.US;
  return MARKETS[suffix] ?? MARKETS.US;
}

/**
 * Local-currency risk-free rate. Floored at 0.5% so that a market with a large
 * negative spread cannot produce a nonsensical near-zero or negative discount
 * rate when the US yield is low.
 */
export function localRiskFreeRate(usTenYear: number, m: MarketParams): number {
  return Math.max(usTenYear + m.riskFreeSpread, 0.005);
}

/**
 * Pre-tax cost of debt. Koller Ch. 13 prefers the yield to maturity on the
 * company's traded debt; absent that, the effective interest rate implied by
 * the interest burden is the best free-data proxy. Falls back to the risk-free
 * rate plus a leverage-scaled spread.
 */
export function costOfDebt(
  interestExpense: number | null,
  totalDebt: number | null,
  riskFreeRate: number,
  debtToCapital: number
): { rate: number; basis: 'interest burden' | 'leverage spread' } {
  if (interestExpense !== null && totalDebt !== null && totalDebt > 0) {
    const implied = interestExpense / totalDebt;
    // Reject implausible results: near-zero implies capitalized or subsidized
    // interest, very high implies a mismatch between the two line items.
    if (implied > 0.005 && implied < 0.25) return { rate: implied, basis: 'interest burden' };
  }
  const spread = 0.008 + 0.045 * Math.min(Math.max(debtToCapital, 0), 0.9);
  return { rate: riskFreeRate + spread, basis: 'leverage spread' };
}
