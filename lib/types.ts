// Core data and assumption types shared across the fetch layer, DCF engine, and UI.

export type AccountingFramework = 'us-gaap' | 'ifrs' | 'unknown';

export interface Financials {
  ticker: string;
  companyName: string;
  fiscalYearEnd: string; // e.g. "2025-09-30"
  currency: string; // ISO code the statements are reported in, e.g. "CNY"
  marketName: string; // e.g. "China A (Shanghai)"

  // Income statement (most recent fiscal year / TTM)
  revenue: number;
  ebit: number; // operating income, used as EBITA proxy
  effectiveTaxRate: number; // decimal, e.g. 0.22

  // Cash flow / reinvestment inputs
  depreciationAmortization: number;
  capex: number;
  changeInNWC: number; // positive = cash outflow (increase in working capital)

  // Balance sheet
  investedCapital: number; // net PP&E + operating working capital + goodwill + capitalized R&D
  totalDebt: number; // short + long term debt
  cashAndEquivalents: number;
  minorityInterest: number;

  // Koller Ch. 14: enterprise value converts to equity value only after
  // separating operating from nonoperating items.
  operatingCash: number; // cash required to run the business
  excessCash: number; // cash + short-term investments beyond operating needs
  nonoperatingAssets: number; // long-term/equity investments and similar
  debtEquivalents: number; // unfunded pensions, capitalized leases not in debt

  // Historical growth (for defaulting explicit-period growth assumption)
  revenueCagr3y: number | null;

  // Market data
  sharePrice: number;
  sharesOutstanding: number;
  marketCap: number;
  beta: number | null;

  /** True when the filer looks like a bank/insurer, where enterprise DCF fails. */
  isFinancial: boolean;

  // Flags for fields that couldn't be found and were estimated/defaulted
  estimatedFields: string[];
}

export interface DcfAssumptions {
  // Macro / cost of capital
  riskFreeRate: number; // decimal, in the currency of the cash flows
  equityRiskPremium: number; // decimal
  countryRiskPremium: number; // decimal, additive (Koller, emerging markets)
  beta: number;
  preTaxCostOfDebt: number; // decimal
  taxRate: number; // decimal, used for NOPAT and after-tax cost of debt

  // Forecast structure
  explicitYears: number; // stage 1 length, e.g. 5
  fadeYears: number; // stage 2 length, e.g. 5
  stage1RevenueGrowth: number; // decimal
  terminalGrowth: number; // decimal, long-run (stage/perpetuity) growth
  stage1IncrementalRoic: number; // decimal, ROIC on new invested capital during stage 1
  terminalIncrementalRoic: number; // decimal, ROIC on new capital in perpetuity (McKinsey default: = WACC)
  ebitMarginTarget: number | null; // null = hold current margin flat

  midYearConvention: boolean;
}

export interface ForecastYear {
  year: number;
  revenue: number;
  ebitMargin: number;
  ebit: number;
  nopat: number;
  growth: number;
  incrementalRoic: number;
  reinvestmentRate: number;
  netInvestment: number;
  freeCashFlow: number;
  discountFactor: number;
  presentValue: number;
  /** Invested capital at the start of the year, rolled forward by net investment. */
  investedCapital: number;
  /** NOPAT / opening invested capital. */
  roic: number;
  /** (ROIC - WACC) x opening invested capital, i.e. Koller's economic profit. */
  economicProfit: number;
  pvEconomicProfit: number;
}

// ---------------------------------------------------------------------------
// Reorganization (Koller Part 2 Ch. 9, Part 3 Ch. 18-22)
// ---------------------------------------------------------------------------

export interface LineItem {
  label: string;
  value: number;
  note?: string;
}

export interface Adjustment {
  label: string;
  /** Chapter of Koller the adjustment comes from, e.g. "Ch. 20 (leases)". */
  chapter: string;
  applied: boolean;
  /** What changed, or why the adjustment could not be applied. */
  detail: string;
  effects: { field: string; from: number | null; to: number | null }[];
}

export interface Reorganization {
  accountingFramework: AccountingFramework;
  accountingFrameworkBasis: string;
  reconciliationStatus: 'complete' | 'partial' | 'unresolved';
  investedCapitalBuild: LineItem[];
  nonoperatingAssetsBuild: LineItem[];
  debtEquivalentsBuild: LineItem[];
  totalFundsInvested: number;
  financingBuild: LineItem[];
  financingTotal: number | null;
  financingReconciliationGap: number | null;
  historicalFcfBuild: LineItem[];
  historicalFreeCashFlow: number | null;
  investorFlowBuild: LineItem[];
  investorFlowTotal: number | null;
  investorFlowReconciliationGap: number | null;
  adjustments: Adjustment[];
}

export type Confidence = 'source' | 'derived' | 'estimated' | 'default';

export interface DataQualityRow {
  field: string;
  value: string;
  basis: string;
  confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Analysis of results (Koller Part 2 Ch. 12, 15, 16)
// ---------------------------------------------------------------------------

export interface EconomicProfitCheck {
  openingInvestedCapital: number;
  pvEconomicProfit: number;
  continuingEconomicProfit: number;
  pvContinuingEconomicProfit: number;
  /** IC + PV(EP explicit) + PV(EP continuing). Should equal the DCF result. */
  enterpriseValue: number;
  /** Difference vs the DCF enterprise value, as a fraction of the DCF value. */
  reconciliationError: number;
  currentRoic: number;
  roicSpread: number; // current ROIC - WACC
}

export interface ContinuingValueDiagnostics {
  cvShareOfEnterpriseValue: number;
  impliedCvEbitMultiple: number;
  terminalRoic: number;
  terminalGrowth: number;
  terminalReinvestmentRate: number;
  warnings: string[];
}

export interface SensitivityGrid {
  waccValues: number[];
  growthValues: number[];
  /** fairValues[waccIndex][growthIndex] */
  fairValues: number[][];
  baseWacc: number;
  baseGrowth: number;
}

export interface ImpliedMultiples {
  dcfEvToEbit: number;
  dcfEvToRevenue: number;
  dcfImpliedPe: number;
  marketEvToEbit: number;
  marketPe: number;
}

export interface EquityBridge {
  rows: LineItem[];
  equityValue: number;
  fairValuePerShare: number;
}

export interface Scenario {
  name: string;
  probability: number;
  stage1RevenueGrowth: number;
  stage1IncrementalRoic: number;
  ebitMarginTarget: number | null;
  fairValuePerShare: number;
}

export interface ScenarioAnalysis {
  scenarios: Scenario[];
  weightedFairValuePerShare: number;
  rationale: string;
}

export interface DcfResult {
  wacc: number;
  costOfEquity: number;
  afterTaxCostOfDebt: number;
  weightOfEquity: number;
  weightOfDebt: number;
  costOfDebtBasis: string;

  forecast: ForecastYear[];
  pvExplicitFcf: number;
  continuingValue: number;
  pvContinuingValue: number;
  enterpriseValue: number;

  netDebt: number;
  minorityInterest: number;
  equityValue: number;
  fairValuePerShare: number;

  bridge: EquityBridge;
  economicProfit: EconomicProfitCheck;
  continuingValueDiagnostics: ContinuingValueDiagnostics;
  sensitivity: SensitivityGrid;
  impliedMultiples: ImpliedMultiples;
  scenarios: ScenarioAnalysis | null;

  marketPrice: number;
  marketCap: number;
  valuationGapPct: number; // (fair value - market price) / market price
  verdict: 'undervalued' | 'overvalued' | 'fairly valued';
}
