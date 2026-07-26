// Free, keyless access to SEC EDGAR's XBRL "company facts" API for US-listed
// filers. SEC asks all automated callers to send a descriptive User-Agent
// (name + contact email) -- see https://www.sec.gov/os/webmaster-faq#developers.

import { factsFromEdgar, StatementFacts } from './statements';

const SEC_USER_AGENT = 'Valuation Analysis Tool contact@example.com';

export interface XbrlFact {
  end: string;
  start?: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  frame?: string;
}

export interface CompanyFacts {
  entityName: string;
  facts: {
    'us-gaap'?: Record<string, { units: Record<string, XbrlFact[]> }>;
    dei?: Record<string, { units: Record<string, XbrlFact[]> }>;
  };
}

type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;
let tickerMapCache: TickerMap | null = null;

async function fetchJson(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`SEC request failed (${res.status}) for ${url}`);
  return res.json();
}

export async function resolveTickerToCik(ticker: string): Promise<{ cik: string; title: string } | null> {
  if (!tickerMapCache) {
    const data = (await fetchJson('https://www.sec.gov/files/company_tickers.json')) as TickerMap;
    tickerMapCache = data;
  }
  const upper = ticker.toUpperCase();
  const entry = Object.values(tickerMapCache!).find((e) => e.ticker.toUpperCase() === upper);
  if (!entry) return null;
  return { cik: String(entry.cik_str).padStart(10, '0'), title: entry.title };
}

export async function fetchCompanyFacts(cik: string): Promise<CompanyFacts> {
  return fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
}

/** Picks the most recent annual (~350-380 day) duration value for a flow concept. */
function latestAnnualDuration(items: XbrlFact[] | undefined): { value: number; end: string } | null {
  if (!items || items.length === 0) return null;
  const annual = items.filter((i) => {
    if (!i.start) return false;
    const days = (new Date(i.end).getTime() - new Date(i.start).getTime()) / 86400000;
    return days >= 340 && days <= 380 && i.form.startsWith('10-K');
  });
  if (annual.length === 0) return null;
  annual.sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
  return { value: annual[0].val, end: annual[0].end };
}

/** Picks the most recent instant (point-in-time) value for a stock/balance-sheet concept. */
function latestInstant(items: XbrlFact[] | undefined): { value: number; end: string } | null {
  if (!items || items.length === 0) return null;
  const instants = items.filter((i) => !i.start);
  if (instants.length === 0) return null;
  instants.sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
  return { value: instants[0].val, end: instants[0].end };
}

/**
 * Instant values one fiscal year apart, most recent first. Needed for genuine
 * year-over-year *changes* (e.g. the change in working capital) as opposed to
 * balance-sheet levels.
 */
function instantsYearApart(items: XbrlFact[] | undefined): number[] {
  if (!items || items.length === 0) return [];
  const byEnd = new Map<string, number>();
  for (const i of items) if (!i.start) byEnd.set(i.end, i.val);
  const sorted = [...byEnd.entries()].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());
  if (sorted.length === 0) return [];
  const out: { end: string; val: number }[] = [{ end: sorted[0][0], val: sorted[0][1] }];
  for (const [end, val] of sorted.slice(1)) {
    const gap = (new Date(out[out.length - 1].end).getTime() - new Date(end).getTime()) / 86400000;
    if (gap >= 340 && gap <= 400) out.push({ end, val });
    if (out.length >= 5) break;
  }
  return out.map((o) => o.val);
}

/**
 * The freshest match across the candidate tags -- deliberately NOT the first
 * tag that returns anything.
 *
 * A tag list is ordered by preference, but a filer that migrated concepts
 * leaves the abandoned tag in companyfacts forever, still holding its old
 * frames. Microsoft moved revenue off `Revenues` when ASC 606 came in, so
 * `Revenues` survives with nothing newer than fiscal 2010. Taking the first
 * non-empty tag therefore valued Microsoft on its fiscal-2010 income statement
 * and disclosed it only as "fiscal year end 2010-06-30" in the workbook header.
 *
 * Freshness decides; tag order only breaks ties. That keeps the preference
 * ordering meaningful in the normal case, where several tags cover the same
 * period and the first is the one we actually want.
 */
function bestMatch(
  facts: CompanyFacts,
  tags: string[],
  picker: (items: XbrlFact[] | undefined) => { value: number; end: string } | null
): { value: number; end: string; tag: string } | null {
  let best: { value: number; end: string; tag: string } | null = null;
  for (const tag of tags) {
    const picked = picker(facts.facts['us-gaap']?.[tag]?.units?.USD);
    if (!picked) continue;
    // Strictly greater, so an equal period end leaves the earlier (preferred)
    // tag in place.
    if (best === null || new Date(picked.end).getTime() > new Date(best.end).getTime()) {
      best = { ...picked, tag };
    }
  }
  return best;
}

/**
 * Last N annual figures for a flow concept (most recent first). Same freshness
 * rule as `bestMatch`: a deprecated tag with a long history must not outrank
 * the tag the filer actually reports under now, or the growth rate is measured
 * across a decade-old window.
 */
function annualHistory(facts: CompanyFacts, tags: string[], count: number): number[] {
  let best: { end: number; values: number[] } | null = null;
  for (const tag of tags) {
    const items = facts.facts['us-gaap']?.[tag]?.units?.USD;
    if (!items) continue;
    const annual = items.filter((i) => {
      if (!i.start) return false;
      const days = (new Date(i.end).getTime() - new Date(i.start).getTime()) / 86400000;
      return days >= 340 && days <= 380 && i.form.startsWith('10-K');
    });
    if (annual.length === 0) continue;
    const byYear = new Map<string, XbrlFact>();
    for (const a of annual) byYear.set(a.end, a); // de-dupe restated filings by period end
    const sorted = [...byYear.values()].sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
    const latest = new Date(sorted[0].end).getTime();
    if (best === null || latest > best.end) {
      best = { end: latest, values: sorted.slice(0, count).map((s) => s.val) };
    }
  }
  return best?.values ?? [];
}

export const TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
  ebit: ['OperatingIncomeLoss'],
  incomeTaxExpense: ['IncomeTaxExpenseBenefit'],
  incomeBeforeTax: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ],
  depreciationAmortization: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsForCapitalImprovements', 'PaymentsToAcquireProductiveAssets'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  shortTermDebt: ['ShortTermBorrowings', 'DebtCurrent', 'LongTermDebtCurrent'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  netPPE: ['PropertyPlantAndEquipmentNet'],
  minorityInterest: ['MinorityInterest'],
  interestExpense: ['InterestExpense', 'InterestExpenseDebt', 'InterestIncomeExpenseNet'],

  // Added for the Koller Ch. 9 reorganization and the Part 3 adjustments.
  totalAssets: ['Assets'],
  totalEquity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  goodwill: ['Goodwill'],
  intangibles: ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet'],
  shortTermInvestments: ['ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'MarketableSecuritiesCurrent'],
  longTermInvestments: ['LongTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent', 'MarketableSecuritiesNoncurrent'],
  equityInvestments: ['EquityMethodInvestments', 'EquitySecuritiesFvNiCurrentAndNoncurrent'],
  // ASC 842 splits the operating-lease liability across current and noncurrent.
  operatingLeaseLiabilityCurrent: ['OperatingLeaseLiabilityCurrent'],
  operatingLeaseLiabilityNoncurrent: ['OperatingLeaseLiabilityNoncurrent'],
  operatingLeaseLiabilityTotal: ['OperatingLeaseLiability'],
  operatingLeaseAssets: ['OperatingLeaseRightOfUseAsset'],
  pensionObligations: [
    'DefinedBenefitPlanBenefitObligation',
    'PensionAndOtherPostretirementDefinedBenefitPlansLiabilitiesNoncurrent',
  ],
  deferredTaxLiabilities: ['DeferredIncomeTaxLiabilitiesNet', 'DeferredTaxLiabilitiesNoncurrent'],
  researchDevelopment: ['ResearchAndDevelopmentExpense'],
  interestIncome: ['InvestmentIncomeInterest', 'InterestAndDividendIncomeOperating'],
  netIncome: ['NetIncomeLoss'],
  stockBasedCompensation: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  ebitda: [],
};

export interface SecExtract {
  companyName: string;
  fiscalYearEnd: string;
  revenue: number | null;
  ebit: number | null;
  effectiveTaxRate: number | null;
  depreciationAmortization: number | null;
  capex: number | null;
  changeInNWC: number | null;
  investedCapital: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  minorityInterest: number | null;
  revenueCagr3y: number | null;
  interestExpense: number | null;
  sharesOutstanding: number | null;
  missing: string[];
}

/**
 * The full statement fact set a US filer needs for the Koller Ch. 9
 * reorganization and the Part 3 adjustments. Same normalized shape the
 * stockanalysis.com path produces, so downstream code is source-agnostic.
 */
export function edgarStatementFacts(facts: CompanyFacts): StatementFacts {
  const inst = (tags: string[]) => bestMatch(facts, tags, latestInstant)?.value ?? null;
  const flow = (tags: string[]) => bestMatch(facts, tags, latestAnnualDuration)?.value ?? null;

  const currentAssets = inst(TAGS.currentAssets);
  const currentLiabilities = inst(TAGS.currentLiabilities);
  // Cash is taken from the most recent balance sheet on file, which for a
  // filer that has reported since its 10-K is the latest 10-Q. That is the
  // right choice for a bridge computed as of today, but it means the cash
  // date can differ from the income statement's fiscal year, so record which
  // balance sheet it was and whether it is interim.
  const cashMatch = bestMatch(facts, TAGS.cash, latestInstant);
  const cash = cashMatch?.value ?? null;
  const fiscalYearEndDate = bestMatch(facts, TAGS.revenue, latestAnnualDuration)?.end ?? null;
  const shortDebt = inst(TAGS.shortTermDebt);
  const longDebt = inst(TAGS.longTermDebt);

  const workingCapital =
    currentAssets !== null && currentLiabilities !== null ? currentAssets - currentLiabilities : null;

  const leaseTotal = inst(TAGS.operatingLeaseLiabilityTotal);
  const leaseCurrent = inst(TAGS.operatingLeaseLiabilityCurrent);
  const leaseNoncurrent = inst(TAGS.operatingLeaseLiabilityNoncurrent);
  const operatingLeaseLiabilities =
    leaseTotal ?? (leaseCurrent !== null || leaseNoncurrent !== null ? (leaseCurrent ?? 0) + (leaseNoncurrent ?? 0) : null);

  const caSeries = instantsYearApart(facts.facts['us-gaap']?.[TAGS.currentAssets[0]]?.units?.USD);
  const clSeries = instantsYearApart(facts.facts['us-gaap']?.[TAGS.currentLiabilities[0]]?.units?.USD);
  const changeInNWC =
    caSeries.length >= 2 && clSeries.length >= 2
      ? caSeries[0] - clSeries[0] - (caSeries[1] - clSeries[1])
      : null;

  const capex = flow(TAGS.capex);
  const interestExpense = flow(TAGS.interestExpense);
  const totalDebt = shortDebt !== null || longDebt !== null ? (shortDebt ?? 0) + (longDebt ?? 0) : null;

  return factsFromEdgar({
    netPPE: inst(TAGS.netPPE),
    workingCapital,
    goodwill: inst(TAGS.goodwill),
    intangibles: inst(TAGS.intangibles),
    totalAssets: inst(TAGS.totalAssets),
    totalEquity: inst(TAGS.totalEquity),

    cash,
    shortTermInvestments: inst(TAGS.shortTermInvestments),
    longTermInvestments: inst(TAGS.longTermInvestments),
    equityInvestments: inst(TAGS.equityInvestments),

    totalDebt,
    operatingLeaseLiabilities,
    operatingLeaseAssets: inst(TAGS.operatingLeaseAssets),
    pensionObligations: inst(TAGS.pensionObligations),
    deferredTaxLiabilities: inst(TAGS.deferredTaxLiabilities),
    minorityInterest: inst(TAGS.minorityInterest),

    depreciationAmortization: flow(TAGS.depreciationAmortization),
    capex: capex === null ? null : Math.abs(capex),
    changeInNWC,
    stockBasedCompensation: flow(TAGS.stockBasedCompensation),

    revenue: flow(TAGS.revenue),
    ebit: flow(TAGS.ebit),
    researchDevelopment: flow(TAGS.researchDevelopment),
    interestExpense: interestExpense === null ? null : Math.abs(interestExpense),
    interestIncome: flow(TAGS.interestIncome),
    pretaxIncome: flow(TAGS.incomeBeforeTax),
    incomeTaxExpense: flow(TAGS.incomeTaxExpense),
    netIncome: flow(TAGS.netIncome),

    revenueHistory: annualHistory(facts, TAGS.revenue, 8),
    ebitHistory: annualHistory(facts, TAGS.ebit, 8),
    researchDevelopmentHistory: annualHistory(facts, TAGS.researchDevelopment, 5),

    cashSource:
      cashMatch === null
        ? null
        : {
            field: cashMatch.tag,
            period: cashMatch.end,
            interim: fiscalYearEndDate !== null && cashMatch.end !== fiscalYearEndDate,
          },
  });
}

export function extractFinancials(facts: CompanyFacts): SecExtract {
  const missing: string[] = [];

  const revenue = bestMatch(facts, TAGS.revenue, latestAnnualDuration);
  const ebit = bestMatch(facts, TAGS.ebit, latestAnnualDuration);
  const taxExpense = bestMatch(facts, TAGS.incomeTaxExpense, latestAnnualDuration);
  const preTaxIncome = bestMatch(facts, TAGS.incomeBeforeTax, latestAnnualDuration);
  const da = bestMatch(facts, TAGS.depreciationAmortization, latestAnnualDuration);
  const capex = bestMatch(facts, TAGS.capex, latestAnnualDuration);
  const currentAssetsThis = bestMatch(facts, TAGS.currentAssets, latestInstant);
  const currentLiabThis = bestMatch(facts, TAGS.currentLiabilities, latestInstant);
  const cash = bestMatch(facts, TAGS.cash, latestInstant);
  const shortDebt = bestMatch(facts, TAGS.shortTermDebt, latestInstant);
  const longDebt = bestMatch(facts, TAGS.longTermDebt, latestInstant);
  const netPPE = bestMatch(facts, TAGS.netPPE, latestInstant);
  const minority = bestMatch(facts, TAGS.minorityInterest, latestInstant);
  const interestExpense = bestMatch(facts, TAGS.interestExpense, latestAnnualDuration);
  // Shares outstanding lives in the "dei" namespace (cover-page data), not us-gaap.
  // Note: for multi-class share structures this reports one class's latest count,
  // so it can understate the total -- the value is editable in the UI.
  const sharesOutstanding = latestInstant(
    facts.facts.dei?.['EntityCommonStockSharesOutstanding']?.units?.shares
  );

  if (!revenue) missing.push('revenue');
  if (!ebit) missing.push('ebit');
  if (!da) missing.push('depreciationAmortization');
  if (!capex) missing.push('capex');
  if (!netPPE) missing.push('investedCapital (net PP&E)');

  const effectiveTaxRate =
    taxExpense && preTaxIncome && preTaxIncome.value !== 0 ? taxExpense.value / preTaxIncome.value : null;
  if (!effectiveTaxRate) missing.push('effectiveTaxRate');

  // Operating working capital *level*: current assets excluding cash, less
  // current liabilities excluding short-term debt (Koller Ch. 9).
  const nwc =
    currentAssetsThis && currentLiabThis && cash && shortDebt
      ? (currentAssetsThis.value - cash.value) - (currentLiabThis.value - shortDebt.value)
      : null;

  // The *change* in working capital is a separate quantity, computed from the
  // two most recent year-ends. Positive = cash outflow (working capital grew).
  const caSeries = instantsYearApart(facts.facts['us-gaap']?.[TAGS.currentAssets[0]]?.units?.USD);
  const clSeries = instantsYearApart(facts.facts['us-gaap']?.[TAGS.currentLiabilities[0]]?.units?.USD);
  const changeInNWC =
    caSeries.length >= 2 && clSeries.length >= 2
      ? caSeries[0] - clSeries[0] - (caSeries[1] - clSeries[1])
      : null;

  const investedCapital = netPPE ? netPPE.value + (nwc ?? 0) : null;
  const totalDebt = (shortDebt?.value ?? 0) + (longDebt?.value ?? 0);

  const revHistory = annualHistory(facts, TAGS.revenue, 4);
  let revenueCagr3y: number | null = null;
  if (revHistory.length >= 4 && revHistory[3] > 0) {
    revenueCagr3y = Math.pow(revHistory[0] / revHistory[3], 1 / 3) - 1;
  } else if (revHistory.length >= 2 && revHistory[revHistory.length - 1] > 0) {
    const n = revHistory.length - 1;
    revenueCagr3y = Math.pow(revHistory[0] / revHistory[revHistory.length - 1], 1 / n) - 1;
  }

  return {
    companyName: facts.entityName,
    fiscalYearEnd: revenue?.end ?? ebit?.end ?? 'unknown',
    revenue: revenue?.value ?? null,
    ebit: ebit?.value ?? null,
    effectiveTaxRate,
    depreciationAmortization: da?.value ?? null,
    capex: capex?.value ?? null,
    changeInNWC,
    investedCapital,
    totalDebt,
    cashAndEquivalents: cash?.value ?? null,
    minorityInterest: minority?.value ?? 0,
    revenueCagr3y,
    interestExpense: interestExpense?.value ?? null,
    sharesOutstanding: sharesOutstanding?.value ?? null,
    missing,
  };
}
