import {
  ContinuingValueDiagnostics,
  DcfAssumptions,
  DcfResult,
  EconomicProfitCheck,
  EquityBridge,
  Financials,
  ForecastYear,
  ImpliedMultiples,
  LineItem,
  Scenario,
  ScenarioAnalysis,
  SensitivityGrid,
} from './types';

/**
 * Enterprise DCF engine implementing the value-driver framework from
 * Koller, Goedhart & Wessels, "Valuation: Measuring and Managing the Value
 * of Companies" (McKinsey & Company).
 *
 * Core mechanics (Part 2, Ch. 8 "Frameworks for Valuation" and Ch. 10-11
 * "Forecasting Performance"):
 *   1. NOPAT = EBIT x (1 - operating tax rate)   [Ch. 18 for the tax rate]
 *   2. Reinvestment rate = growth / incremental ROIC (RONIC)
 *   3. Free cash flow = NOPAT x (1 - reinvestment rate)
 *   4. Two-stage forecast: an explicit stage at the firm's current growth/ROIC,
 *      then a "fade" stage where growth and incremental ROIC converge toward
 *      long-run, competitive-equilibrium levels (growth -> terminal growth,
 *      RONIC -> WACC by default, i.e. no economic profit on new capital).
 *   5. Continuing value via the Key Value Driver Formula (Ch. 12):
 *        CV = NOPAT_(T+1) x (1 - g / RONIC) / (WACC - g)
 *   6. Enterprise value = PV(explicit FCF) + PV(continuing value)
 *   7. Enterprise-to-equity bridge (Ch. 14): subtract debt and debt
 *      equivalents, add excess cash and nonoperating assets, subtract
 *      minority interest.
 *   8. Fair value per share = Equity value / diluted shares outstanding
 *
 * Two independent cross-checks accompany the result:
 *   - The economic-profit identity (Ch. 8/9): enterprise value must also equal
 *     invested capital plus the present value of economic profits.
 *   - Continuing-value diagnostics (Ch. 12) and implied multiples (Ch. 15/16),
 *     which is how Koller sanity-checks a DCF against the market.
 */

/**
 * WACC (Ch. 13). Cost of equity is CAPM with an additive country risk premium
 * for less-integrated markets (Part 5). Debt is total debt plus debt
 * equivalents (leases and unfunded pensions, Ch. 19/20), because those are
 * financing claims whose cost the capital structure has to reflect.
 */
export function calculateWacc(f: Financials, a: DcfAssumptions) {
  const costOfEquity = a.riskFreeRate + a.beta * a.equityRiskPremium + a.countryRiskPremium;
  const afterTaxCostOfDebt = a.preTaxCostOfDebt * (1 - a.taxRate);

  const marketValueEquity = f.marketCap;
  // Book value used as a proxy for the market value of debt (Ch. 13 accepts
  // this for investment-grade, non-distressed issuers).
  const marketValueDebt = f.totalDebt + f.debtEquivalents;
  const totalCapital = marketValueEquity + marketValueDebt;

  const weightOfEquity = totalCapital > 0 ? marketValueEquity / totalCapital : 1;
  const weightOfDebt = totalCapital > 0 ? marketValueDebt / totalCapital : 0;

  const wacc = weightOfEquity * costOfEquity + weightOfDebt * afterTaxCostOfDebt;

  return { wacc, costOfEquity, afterTaxCostOfDebt, weightOfEquity, weightOfDebt };
}

function lerp(start: number, end: number, t: number, totalSteps: number) {
  if (totalSteps <= 0) return end;
  const frac = Math.min(Math.max(t / totalSteps, 0), 1);
  return start + (end - start) * frac;
}

/** RONIC falls back to the WACC when the caller left it unset (Ch. 12 default). */
function ronic(value: number, wacc: number): number {
  return Number.isFinite(value) && value > 0 ? value : wacc;
}

export function buildForecast(f: Financials, a: DcfAssumptions, wacc: number): ForecastYear[] {
  const baseMargin = f.revenue > 0 ? f.ebit / f.revenue : 0;
  const totalYears = a.explicitYears + a.fadeYears;
  const forecast: ForecastYear[] = [];
  const terminalRonic = ronic(a.terminalIncrementalRoic, wacc);

  let priorRevenue = f.revenue;
  // Invested capital rolls forward by net investment, so ROIC and economic
  // profit are computed on a real capital base rather than assumed.
  let openingInvestedCapital = f.investedCapital;

  for (let t = 1; t <= totalYears; t++) {
    const inFade = t > a.explicitYears;
    const fadeStep = inFade ? t - a.explicitYears : 0;

    const growth = inFade
      ? lerp(a.stage1RevenueGrowth, a.terminalGrowth, fadeStep, a.fadeYears)
      : a.stage1RevenueGrowth;

    const incrementalRoic = inFade
      ? lerp(a.stage1IncrementalRoic, terminalRonic, fadeStep, a.fadeYears)
      : a.stage1IncrementalRoic;

    const ebitMargin =
      a.ebitMarginTarget === null ? baseMargin : lerp(baseMargin, a.ebitMarginTarget, t, totalYears);

    const revenue = priorRevenue * (1 + growth);
    const ebit = revenue * ebitMargin;
    const nopat = ebit * (1 - a.taxRate);
    const reinvestmentRate = incrementalRoic > 0 ? growth / incrementalRoic : 0;
    const netInvestment = nopat * reinvestmentRate;
    const freeCashFlow = nopat - netInvestment;

    const exponent = a.midYearConvention ? t - 0.5 : t;
    const discountFactor = 1 / Math.pow(1 + wacc, exponent);
    const presentValue = freeCashFlow * discountFactor;

    // The economic-profit identity only holds on end-of-year discounting, so
    // the EP leg keeps its own factor regardless of the mid-year convention.
    const eoyFactor = 1 / Math.pow(1 + wacc, t);
    const roic = openingInvestedCapital > 0 ? nopat / openingInvestedCapital : 0;
    const economicProfit = openingInvestedCapital > 0 ? (roic - wacc) * openingInvestedCapital : 0;

    forecast.push({
      year: t,
      revenue,
      ebitMargin,
      ebit,
      nopat,
      growth,
      incrementalRoic,
      reinvestmentRate,
      netInvestment,
      freeCashFlow,
      discountFactor,
      presentValue,
      investedCapital: openingInvestedCapital,
      roic,
      economicProfit,
      pvEconomicProfit: economicProfit * eoyFactor,
    });

    priorRevenue = revenue;
    openingInvestedCapital = openingInvestedCapital + netInvestment;
  }

  return forecast;
}

/** Continuing value from the Key Value Driver Formula (Ch. 12). */
function continuingValueOf(lastYear: ForecastYear, a: DcfAssumptions, wacc: number, growth: number): number {
  const nopatNextYear = lastYear.nopat * (1 + growth);
  const terminalRonic = ronic(a.terminalIncrementalRoic, wacc);
  if (wacc <= growth) return NaN; // caller guards; a perpetuity is undefined here
  return (nopatNextYear * (1 - growth / terminalRonic)) / (wacc - growth);
}

/** Enterprise value only, used by the sensitivity grid and scenarios. */
function enterpriseValueAt(f: Financials, a: DcfAssumptions, wacc: number, growth: number): number {
  const assumptions = { ...a, terminalGrowth: growth };
  const forecast = buildForecast(f, assumptions, wacc);
  const pvFcf = forecast.reduce((s, y) => s + y.presentValue, 0);
  const last = forecast[forecast.length - 1];
  const cv = continuingValueOf(last, assumptions, wacc, growth);
  if (!isFinite(cv)) return NaN;
  return pvFcf + cv * last.discountFactor;
}

/** Ch. 14: enterprise value to equity value per share. */
function buildBridge(f: Financials, enterpriseValue: number): EquityBridge {
  const rows: LineItem[] = [
    { label: 'Enterprise value (DCF)', value: enterpriseValue },
    { label: 'Less: total debt', value: -f.totalDebt },
  ];
  if (f.debtEquivalents > 0) {
    rows.push({
      label: 'Less: debt equivalents',
      value: -f.debtEquivalents,
      note: 'operating leases and unfunded pensions (Ch. 19/20)',
    });
  }
  rows.push({
    label: 'Plus: excess cash',
    value: f.excessCash,
    note: 'cash and short-term investments beyond operating needs',
  });
  if (f.nonoperatingAssets > 0) {
    rows.push({
      label: 'Plus: nonoperating assets',
      value: f.nonoperatingAssets,
      note: 'long-term and equity-method investments (Ch. 19)',
    });
  }
  if (f.minorityInterest !== 0) {
    rows.push({ label: 'Less: minority interest', value: -f.minorityInterest });
  }

  const equityValue = rows.reduce((s, r) => s + r.value, 0);
  const fairValuePerShare = f.sharesOutstanding > 0 ? equityValue / f.sharesOutstanding : 0;

  rows.push({ label: 'Equity value', value: equityValue });
  return { rows, equityValue, fairValuePerShare };
}

/**
 * Ch. 8/9 economic-profit identity:
 *   EV = invested capital + PV(economic profit) + PV(continuing economic profit)
 * where continuing economic profit value = continuing value - terminal
 * invested capital. Both legs use end-of-year discounting, so a non-trivial
 * reconciliation error means the forecast arithmetic is inconsistent, not that
 * the discounting convention differs.
 */
function economicProfitCheck(
  f: Financials,
  a: DcfAssumptions,
  wacc: number,
  forecast: ForecastYear[],
  continuingValue: number
): EconomicProfitCheck {
  const totalYears = forecast.length;
  const last = forecast[totalYears - 1];
  const terminalInvestedCapital = last.investedCapital + last.netInvestment;
  const eoyTerminal = 1 / Math.pow(1 + wacc, totalYears);

  const pvEconomicProfit = forecast.reduce((s, y) => s + y.pvEconomicProfit, 0);
  const continuingEconomicProfit = continuingValue - terminalInvestedCapital;
  const pvContinuingEconomicProfit = continuingEconomicProfit * eoyTerminal;

  const enterpriseValue = f.investedCapital + pvEconomicProfit + pvContinuingEconomicProfit;

  // The DCF leg on the same end-of-year basis, for an apples-to-apples check.
  const dcfEoy =
    forecast.reduce((s, y) => s + y.freeCashFlow / Math.pow(1 + wacc, y.year), 0) +
    continuingValue * eoyTerminal;

  const currentRoic = f.investedCapital > 0 ? (f.ebit * (1 - a.taxRate)) / f.investedCapital : 0;

  return {
    openingInvestedCapital: f.investedCapital,
    pvEconomicProfit,
    continuingEconomicProfit,
    pvContinuingEconomicProfit,
    enterpriseValue,
    reconciliationError: dcfEoy !== 0 ? (enterpriseValue - dcfEoy) / Math.abs(dcfEoy) : 0,
    currentRoic,
    roicSpread: currentRoic - wacc,
  };
}

/** Ch. 12: is the continuing value doing too much work, and is it internally sane? */
function cvDiagnostics(
  a: DcfAssumptions,
  wacc: number,
  forecast: ForecastYear[],
  continuingValue: number,
  pvContinuingValue: number,
  enterpriseValue: number
): ContinuingValueDiagnostics {
  const last = forecast[forecast.length - 1];
  const terminalRonic = ronic(a.terminalIncrementalRoic, wacc);
  const ebitNextYear = last.ebit * (1 + a.terminalGrowth);
  const share = enterpriseValue !== 0 ? pvContinuingValue / enterpriseValue : 0;
  const multiple = ebitNextYear !== 0 ? continuingValue / ebitNextYear : 0;
  const reinvestment = terminalRonic > 0 ? a.terminalGrowth / terminalRonic : 0;

  const warnings: string[] = [];
  if (share > 0.85) {
    warnings.push(
      `The continuing value is ${(share * 100).toFixed(0)}% of enterprise value. Koller notes this is normal for a growing business, but it means the answer is driven almost entirely by the terminal assumptions rather than the explicit forecast.`
    );
  }
  if (a.terminalGrowth > a.riskFreeRate) {
    warnings.push(
      `Terminal growth of ${(a.terminalGrowth * 100).toFixed(1)}% exceeds the ${(a.riskFreeRate * 100).toFixed(1)}% risk-free rate, which implies real perpetual growth above the long-run economy. Ch. 12 caps long-run growth at nominal GDP.`
    );
  }
  if (terminalRonic > wacc * 1.5) {
    warnings.push(
      `Terminal RONIC of ${(terminalRonic * 100).toFixed(1)}% is more than 1.5x the ${(wacc * 100).toFixed(1)}% WACC, i.e. the model assumes a permanent competitive advantage on all new capital. Ch. 12's default is RONIC = WACC.`
    );
  }
  if (multiple > 25) {
    warnings.push(
      `The continuing value implies a ${multiple.toFixed(1)}x forward EBIT multiple, which is high for a mature business.`
    );
  }
  if (wacc - a.terminalGrowth < 0.03) {
    warnings.push(
      `The WACC-minus-growth spread is only ${((wacc - a.terminalGrowth) * 100).toFixed(1)} percentage points, so the perpetuity is numerically unstable and small assumption changes will swing the value hard.`
    );
  }

  return {
    cvShareOfEnterpriseValue: share,
    impliedCvEbitMultiple: multiple,
    terminalRoic: terminalRonic,
    terminalGrowth: a.terminalGrowth,
    terminalReinvestmentRate: reinvestment,
    warnings,
  };
}

/** Ch. 15: how the answer moves with the two assumptions it is most sensitive to. */
function sensitivityGrid(f: Financials, a: DcfAssumptions, wacc: number): SensitivityGrid {
  const waccValues = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => wacc + d).filter((w) => w > 0.01);
  const growthValues = [-0.01, -0.005, 0, 0.005, 0.01].map((d) => a.terminalGrowth + d);

  const fairValues = waccValues.map((w) =>
    growthValues.map((g) => {
      if (w - g < 0.005) return NaN;
      const ev = enterpriseValueAt(f, a, w, g);
      if (!isFinite(ev)) return NaN;
      return buildBridge(f, ev).fairValuePerShare;
    })
  );

  return { waccValues, growthValues, fairValues, baseWacc: wacc, baseGrowth: a.terminalGrowth };
}

/**
 * Ch. 15/16: translate the DCF back into multiples and put them next to the
 * market's. The P/E lines are computed on NOPAT rather than reported net
 * income so that the DCF and market figures sit on the same basis.
 */
function impliedMultiples(f: Financials, a: DcfAssumptions, enterpriseValue: number, equityValue: number): ImpliedMultiples {
  const nopat = f.ebit * (1 - a.taxRate);
  const marketEnterpriseValue =
    f.marketCap + f.totalDebt + f.debtEquivalents - f.excessCash - f.nonoperatingAssets + f.minorityInterest;

  return {
    dcfEvToEbit: f.ebit !== 0 ? enterpriseValue / f.ebit : 0,
    dcfEvToRevenue: f.revenue !== 0 ? enterpriseValue / f.revenue : 0,
    dcfImpliedPe: nopat !== 0 ? equityValue / nopat : 0,
    marketEvToEbit: f.ebit !== 0 ? marketEnterpriseValue / f.ebit : 0,
    marketPe: nopat !== 0 ? f.marketCap / nopat : 0,
  };
}

/**
 * Part 5, high-growth companies: a single point forecast understates the range
 * of outcomes, so Koller values several weighted scenarios instead. Triggered
 * only when the base case already assumes rapid growth, since that is where
 * the single-scenario bias bites.
 */
function scenarioAnalysis(f: Financials, a: DcfAssumptions, wacc: number): ScenarioAnalysis | null {
  if (a.stage1RevenueGrowth < 0.15) return null;

  const specs: { name: string; probability: number; growthMult: number; roicMult: number; marginMult: number }[] = [
    { name: 'Scales as planned', probability: 0.25, growthMult: 1.3, roicMult: 1.15, marginMult: 1.1 },
    { name: 'Base case', probability: 0.5, growthMult: 1, roicMult: 1, marginMult: 1 },
    { name: 'Growth stalls early', probability: 0.25, growthMult: 0.35, roicMult: 0.7, marginMult: 0.85 },
  ];

  const baseMargin = f.revenue > 0 ? f.ebit / f.revenue : 0;

  const scenarios: Scenario[] = specs.map((s) => {
    const stage1RevenueGrowth = a.stage1RevenueGrowth * s.growthMult;
    const stage1IncrementalRoic = Math.max(a.stage1IncrementalRoic * s.roicMult, 0.02);
    const ebitMarginTarget =
      s.marginMult === 1 ? a.ebitMarginTarget : (a.ebitMarginTarget ?? baseMargin) * s.marginMult;

    const scenarioAssumptions: DcfAssumptions = {
      ...a,
      stage1RevenueGrowth,
      stage1IncrementalRoic,
      ebitMarginTarget,
    };
    const ev = enterpriseValueAt(f, scenarioAssumptions, wacc, a.terminalGrowth);
    const fairValuePerShare = isFinite(ev) ? buildBridge(f, ev).fairValuePerShare : 0;

    return {
      name: s.name,
      probability: s.probability,
      stage1RevenueGrowth,
      stage1IncrementalRoic,
      ebitMarginTarget,
      fairValuePerShare,
    };
  });

  const weightedFairValuePerShare = scenarios.reduce((s, x) => s + x.probability * x.fairValuePerShare, 0);

  return {
    scenarios,
    weightedFairValuePerShare,
    rationale: `Base-case growth of ${(a.stage1RevenueGrowth * 100).toFixed(1)}% qualifies this as a high-growth company under Koller Part 5, where a single forecast systematically misstates value. Three scenarios are weighted 25/50/25: faster scaling with margin expansion, the base case, and an early growth stall with margin compression. Probabilities are a starting point, not a forecast, and are editable.`,
  };
}

export function runDcf(f: Financials, a: DcfAssumptions): DcfResult {
  const { wacc, costOfEquity, afterTaxCostOfDebt, weightOfEquity, weightOfDebt } = calculateWacc(f, a);
  const forecast = buildForecast(f, a, wacc);

  const pvExplicitFcf = forecast.reduce((sum, y) => sum + y.presentValue, 0);
  const lastYear = forecast[forecast.length - 1];

  const rawCv = continuingValueOf(lastYear, a, wacc, a.terminalGrowth);
  const continuingValue = isFinite(rawCv) ? rawCv : (lastYear.nopat * (1 + a.terminalGrowth)) / wacc;

  // Discount the continuing value with the same factor applied to the final
  // explicit cash flow, so the mid-year convention stays internally consistent
  // with the perpetuity's implicit cash-flow timing.
  const pvContinuingValue = continuingValue * lastYear.discountFactor;
  const enterpriseValue = pvExplicitFcf + pvContinuingValue;

  const bridge = buildBridge(f, enterpriseValue);
  const equityValue = bridge.equityValue;
  const fairValuePerShare = bridge.fairValuePerShare;

  const marketPrice = f.sharePrice;
  const valuationGapPct = marketPrice > 0 ? (fairValuePerShare - marketPrice) / marketPrice : 0;

  let verdict: DcfResult['verdict'] = 'fairly valued';
  if (valuationGapPct > 0.075) verdict = 'undervalued';
  else if (valuationGapPct < -0.075) verdict = 'overvalued';

  return {
    wacc,
    costOfEquity,
    afterTaxCostOfDebt,
    weightOfEquity,
    weightOfDebt,
    costOfDebtBasis: '',

    forecast,
    pvExplicitFcf,
    continuingValue,
    pvContinuingValue,
    enterpriseValue,

    // Net debt is kept for the headline stat; the full Ch. 14 walk is in `bridge`.
    netDebt: f.totalDebt + f.debtEquivalents - f.excessCash - f.nonoperatingAssets,
    minorityInterest: f.minorityInterest,
    equityValue,
    fairValuePerShare,

    bridge,
    economicProfit: economicProfitCheck(f, a, wacc, forecast, continuingValue),
    continuingValueDiagnostics: cvDiagnostics(a, wacc, forecast, continuingValue, pvContinuingValue, enterpriseValue),
    sensitivity: sensitivityGrid(f, a, wacc),
    impliedMultiples: impliedMultiples(f, a, enterpriseValue, equityValue),
    scenarios: scenarioAnalysis(f, a, wacc),

    marketPrice,
    marketCap: f.marketCap,
    valuationGapPct,
    verdict,
  };
}

/** Sensible default assumptions, seeded from the fetched financials where possible. */
export function defaultAssumptions(
  f: Financials,
  macro: { riskFreeRate: number; equityRiskPremium?: number; countryRiskPremium?: number; preTaxCostOfDebt?: number }
): DcfAssumptions {
  const currentRoic = f.investedCapital > 0 ? (f.ebit * (1 - f.effectiveTaxRate)) / f.investedCapital : 0.12;
  const growthDefault = f.revenueCagr3y ?? 0.04;

  return {
    riskFreeRate: macro.riskFreeRate,
    equityRiskPremium: macro.equityRiskPremium ?? 0.055,
    countryRiskPremium: macro.countryRiskPremium ?? 0,
    beta: f.beta ?? 1.0,
    preTaxCostOfDebt: macro.preTaxCostOfDebt ?? macro.riskFreeRate + 0.015,
    taxRate: f.effectiveTaxRate > 0 && f.effectiveTaxRate < 0.5 ? f.effectiveTaxRate : 0.23,
    explicitYears: 5,
    fadeYears: 5,
    stage1RevenueGrowth: Math.max(Math.min(growthDefault, 0.3), -0.1),
    terminalGrowth: 0.025,
    // Cap stage-1 RONIC: a very high current ROIC is usually an artifact of an
    // understated capital base, and Ch. 12 warns against extrapolating it.
    stage1IncrementalRoic: Math.max(Math.min(currentRoic, 0.4), 0.03),
    terminalIncrementalRoic: NaN, // set to WACC by caller once WACC is known
    ebitMarginTarget: null,
    midYearConvention: true,
  };
}
