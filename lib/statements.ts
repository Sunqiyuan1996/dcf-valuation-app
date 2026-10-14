// Full financial-statement extraction, used to reorganize the accounting
// statements into NOPAT / invested capital / FCF the way Koller, Goedhart &
// Wessels do in "Valuation" Ch. 9 ("Reorganizing the Financial Statements").
//
// Three sources produce the same normalized StatementFacts shape:
//   - stockanalysis.com's per-statement page payloads (non-US listings), and
//   - Eastmoney's detailed statement feed (China A-share fallback), and
//   - SEC EDGAR XBRL company facts (US listings, see secEdgar.ts).
//
// Every field is nullable. Downstream adjustments (leases, R&D, operating
// taxes) are applied only when their inputs are present, and are otherwise
// skipped and reported in the data-quality panel rather than guessed.

import { decodeDevalueNode, numericSeriesValues, SaListing } from './globalData';
import { AccountingFramework } from './types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** One statement page: field name -> column values, plus the period labels. */
export interface StatementTable {
  fields: Record<string, unknown[]>;
  periods: string[];
  /** True when column 0 is a trailing-twelve-month / current column, not a fiscal year. */
  leadingTtm: boolean;
}

export type StatementKind = 'balance-sheet' | 'cash-flow-statement' | 'income-statement' | 'ratios';

export function statementDataUrl(listing: SaListing, kind: StatementKind): string {
  const base = listing.path.includes('/')
    ? `https://stockanalysis.com/quote/${listing.path}`
    : `https://stockanalysis.com/stocks/${listing.path}`;
  return `${base}/financials/${kind}/__data.json?x-sveltekit-trailing-slash=1`;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function looksLikeFiscalPeriod(s: unknown): boolean {
  return typeof s === 'string' && /\d{4}/.test(s) && !/ttm|current|ltm/i.test(s);
}

/**
 * Fetch one statement page's `__data.json` and flatten it to a StatementTable.
 *
 * Verified shape (etr/SAP balance sheet): the SvelteKit payload's data nodes
 * decode to an object carrying `statement: "<kind>"` and a `financialData`
 * map of field name -> array of column values. Unlike the financials overview
 * page there are no `sections`; columns run most-recent-first and may lead
 * with a TTM/current column, which `periods` lets us detect.
 */
export async function fetchStatementTable(
  listing: SaListing,
  kind: StatementKind
): Promise<StatementTable | null> {
  const payload = await getJson(statementDataUrl(listing, kind));
  const nodes: any[] = Array.isArray(payload?.nodes) ? payload.nodes : [];

  for (const node of nodes) {
    if (node?.type !== 'data' || !Array.isArray(node.data)) continue;
    const root = decodeDevalueNode(node.data);
    if (!root || typeof root !== 'object') continue;
    // Accept either an explicit financialData map or, on the overview-style
    // payload, a top-level `data` map of the same field -> array shape.
    const raw =
      (root.financialData && typeof root.financialData === 'object' && root.financialData) ||
      (root.statement && root.data && typeof root.data === 'object' && root.data) ||
      null;
    if (!raw) continue;

    const fields: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      const series = numericSeriesValues(v);
      if (series.length > 0) fields[k] = series;
    }
    if (Object.keys(fields).length === 0) continue;

    const periodsRaw = fields['datekey'] ?? fields['period'] ?? fields['fiscalYear'] ?? fields['date'] ?? [];
    const periods = periodsRaw.map((p) => (p === null || p === undefined ? '' : String(p)));
    const leadingTtm = periods.length > 0 && !looksLikeFiscalPeriod(periods[0]);
    return { fields, periods, leadingTtm };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field lookup: alias-tolerant, since stockanalysis.com's key names are not a
// documented contract. First alias that resolves to a numeric series wins.
// ---------------------------------------------------------------------------

/**
 * Field keys are matched ignoring case, spaces and punctuation, because the
 * source's key naming is not a documented contract and has been seen in both
 * `totalcash` and `totalCash` forms. Exact hits are tried first so an exact
 * alias always beats a fuzzy one.
 */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function column(table: StatementTable, alias: string): { key: string; values: unknown[] } | null {
  const direct = table.fields[alias];
  if (Array.isArray(direct)) return { key: alias, values: direct };
  const want = normKey(alias);
  for (const k of Object.keys(table.fields)) {
    const v = table.fields[k];
    if (Array.isArray(v) && normKey(k) === want) return { key: k, values: v };
  }
  return null;
}

/** A resolved figure together with where in the statement it was read from. */
export interface FieldSource {
  /** The source's own field name, so a wrong alias match is visible. */
  field: string;
  /** The column's period label, e.g. a fiscal year end or "Current". */
  period: string;
  /** True when that column is an interim or TTM snapshot, not a fiscal year end. */
  interim: boolean;
}

export interface ResolvedValue extends FieldSource {
  value: number;
}

/**
 * Most recent value for the first alias that resolves, including a TTM or
 * interim column when one leads the table, plus the provenance of the column
 * that was used. Levels have no annualization problem, so the freshest balance
 * sheet is preferred over the last fiscal year end even when it is a quarter.
 */
function resolveLatest(table: StatementTable | null, aliases: string[]): ResolvedValue | null {
  if (!table) return null;
  for (const alias of aliases) {
    const col = column(table, alias);
    if (!col) continue;
    for (let i = 0; i < col.values.length; i++) {
      const v = col.values[i];
      if (typeof v === 'number' && isFinite(v)) {
        const period = table.periods[i] ?? '';
        return { value: v, field: col.key, period, interim: !looksLikeFiscalPeriod(period) };
      }
    }
  }
  return null;
}

function numericSeries(table: StatementTable | null, aliases: string[]): number[] | null {
  if (!table) return null;
  for (const alias of aliases) {
    const col = column(table, alias);
    if (!col) continue;
    const start = table.leadingTtm ? 1 : 0;
    const vals = col.values
      .slice(start)
      .map((v) => (typeof v === 'number' && isFinite(v) ? v : null))
      .filter((v): v is number => v !== null);
    if (vals.length > 0) return vals;
  }
  return null;
}

/** Most recent fiscal-year value for the first alias that resolves. */
function latest(table: StatementTable | null, aliases: string[]): number | null {
  const s = numericSeries(table, aliases);
  return s ? s[0] : null;
}

/** Most recent value including a TTM/current column when one is present. */
function latestIncludingTtm(table: StatementTable | null, aliases: string[]): number | null {
  return resolveLatest(table, aliases)?.value ?? null;
}

const A = {
  // --- balance sheet -------------------------------------------------------
  netPPE: ['netPPE', 'ppnet', 'netppe', 'ppe', 'propertyPlantEquipment'],
  workingCapital: ['workingcapital', 'workingCapital', 'wc'],
  currentAssets: ['totalCurrentAssets', 'currentAssets', 'assetsCurrent'],
  currentLiabilities: ['totalCurrentLiabilities', 'currentLiabilities', 'liabilitiesCurrent'],
  totalAssets: ['totalAssets', 'assets'],
  otherOperatingAssets: ['otherOperatingAssets', 'otherLongTermOperatingAssets', 'otherLongTermAssets'],
  otherOperatingLiabilities: ['otherOperatingLiabilities', 'otherLongTermOperatingLiabilities', 'otherLongTermLiabilities'],
  goodwill: ['goodwill'],
  intangibles: ['intangibles', 'otherIntangibleAssets', 'intangibleAssets'],
  goodwillAndIntangibles: ['goodwillAndIntangibles', 'goodwillIntangibles'],
  cash: [
    'cashAndEquivalents',
    'cashAndCashEquivalents',
    'cashAndEq',
    'cashnequivalents',
    'cashEquivalents',
    'totalcash',
    'cashOnHand',
    'cash',
  ],
  // Combined "cash and short-term investments" lines. These already contain
  // short-term investments, so the caller nets them out to avoid double count.
  cashAndInvestments: [
    'cashAndInvestments',
    'cashAndStInvest',
    'totalCashAndInvestments',
    'cashAndShortTermInvestments',
    'totalCashAndShortTermInvestments',
  ],
  shortTermInvestments: ['shortTermInvestments', 'stInvestments', 'investmentsCurrent', 'marketableSecurities'],
  longTermInvestments: ['longTermInvestments', 'ltInvestments', 'investments'],
  equityInvestments: ['equityInvestments', 'investmentsInAffiliates', 'equityMethodInvestments'],
  financialSubsidiaries: ['financialSubsidiaries', 'investmentsInFinancialSubsidiaries'],
  otherNonoperatingAssets: ['otherNonoperatingAssets', 'assetsHeldForSale'],
  totalDebt: ['debt', 'totalDebt'],
  shortTermDebt: ['currentDebt', 'shortTermDebt', 'stDebt'],
  longTermDebt: ['longTermDebt', 'ltDebt', 'nonCurrentDebt'],
  minorityInterest: ['minorityInterestBS', 'minorityInterest', 'noncontrollingInterest'],
  totalEquity: ['shareholdersEquity', 'totalEquity', 'equity', 'totalStockholdersEquity'],
  operatingLeaseLiabilities: [
    'operatingLeaseLiabilities',
    'operatingLeaseLiability',
    'leaseLiabilities',
    'capitalLeaseObligations',
    'operatingLeases',
  ],
  currentLeaseLiabilities: ['currentPortionOfLeases', 'currentLeaseLiabilities', 'leasesCurrent'],
  longTermLeaseLiabilities: ['longTermLeases', 'longTermLeaseLiabilities', 'leasesNonCurrent'],
  operatingLeaseAssets: ['operatingLeaseAssets', 'rightOfUseAssets', 'operatingLeaseRightOfUseAsset'],
  pensionObligations: ['pensionObligations', 'pensions', 'retirementBenefitObligations', 'pensionLiabilities'],
  restructuringReserves: ['restructuringReserves', 'restructuringLiabilities', 'restructuringProvision'],
  overfundedPensionAssets: ['pensionAssets', 'overfundedPensionAssets', 'definedBenefitPlanAssets'],
  deferredTaxLiabilities: ['deferredTaxLiabilities', 'deferredIncomeTaxes', 'deferredTaxes'],
  deferredTaxAssets: ['deferredTaxAssets', 'deferredTaxAssetsNet', 'taxLossCarryforwards'],
  hybridSecurities: ['preferredStock', 'preferredEquity', 'hybridSecurities'],
  deferredRevenue: ['deferredRevenue', 'unearnedRevenue'],
  sharesOutstanding: ['sharesOutTotalCommon', 'sharesOutstanding', 'commonSharesOutstanding'],

  // --- cash flow -----------------------------------------------------------
  depreciationAmortization: [
    'depreciationAmortization',
    'depamor',
    'depreciationAndAmortization',
    'da',
    'depreciation',
  ],
  capex: ['capex', 'capitalExpenditures'],
  changeInNWC: [
    'changeInWorkingCapital',
    'changesInWorkingCapital',
    'workingCapitalChanges',
    'changeInNWC',
    'changeInWorkingCapitalTotal',
  ],
  stockBasedCompensation: ['stockBasedCompensation', 'sbcomp', 'sbc', 'shareBasedCompensation'],
  acquisitions: ['acquisitions', 'netAcquisitions', 'cashAcquisitions'],
  assetDisposals: ['assetDisposals', 'proceedsFromAssetSales', 'saleOfPPE'],
  debtIssuance: ['debtIssued', 'issuanceOfDebt', 'proceedsFromDebt'],
  debtRepayment: ['debtRepayment', 'repaymentOfDebt', 'debtRepaid'],
  dividendsPaid: ['dividendsPaid', 'commonDividendsPaid', 'paymentOfDividends'],
  shareIssuance: ['commonStockIssued', 'issuanceOfCommonStock', 'proceedsFromStockIssuance'],
  shareRepurchases: ['shareRepurchases', 'repurchaseOfCommonStock', 'commonStockRepurchased'],
  operatingCashFlow: ['operatingCashFlow', 'ocf', 'netCashProvidedByOperatingActivities'],

  // --- income statement ----------------------------------------------------
  revenue: ['revenue', 'totalRevenue', 'revenues'],
  ebit: ['opinc', 'operatingIncome', 'ebit'],
  ebitda: ['ebitda'],
  grossProfit: ['grossProfit', 'gp'],
  researchDevelopment: ['rnd', 'researchDevelopment', 'researchAndDevelopment', 'rd', 'randd'],
  sellingGeneralAdmin: ['sga', 'sgna', 'sellingGeneralAndAdministrative'],
  interestExpense: ['interestExpense', 'intexp', 'interestExpenseNet', 'netInterestExpense'],
  interestIncome: ['interestIncome', 'intinc'],
  pretaxIncome: ['pretaxIncome', 'ebt', 'incomeBeforeTaxes', 'incomeBeforeTax'],
  incomeTaxExpense: ['incomeTax', 'taxProvision', 'incomeTaxExpense', 'provisionForIncomeTaxes'],
  netIncome: ['netinccmn', 'netIncome', 'netIncomeCommon'],
  /** Net income as it opens the cash flow statement — the fallback source. */
  netIncomeCashFlow: ['netIncomeCF', 'netIncome', 'netinccmn'],
  nonoperatingIncome: ['otherNonOperatingIncome', 'nonOperatingIncome', 'otherIncome'],
  restructuringCharges: ['restructuringCharges', 'restructuringExpense', 'reorganizationCosts'],
};

/**
 * Reorganized statement inputs. Levels are latest fiscal year end; flows are
 * the latest fiscal year. `*History` series run most-recent-first and drive
 * the cycle normalization in Part 5.
 */
export interface StatementFacts {
  source: 'stockanalysis' | 'eastmoney' | 'edgar';
  accountingFramework: AccountingFramework;

  netPPE: number | null;
  workingCapital: number | null;
  goodwill: number | null;
  intangibles: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  shortTermDebt: number | null;
  otherOperatingAssets: number | null;
  otherOperatingLiabilities: number | null;

  cash: number | null;
  shortTermInvestments: number | null;
  longTermInvestments: number | null;
  equityInvestments: number | null;
  financialSubsidiaries: number | null;
  otherNonoperatingAssets: number | null;

  totalDebt: number | null;
  operatingLeaseLiabilities: number | null;
  currentLeaseLiabilities: number | null;
  operatingLeaseAssets: number | null;
  pensionObligations: number | null;
  restructuringReserves: number | null;
  overfundedPensionAssets: number | null;
  deferredTaxLiabilities: number | null;
  deferredTaxAssets: number | null;
  hybridSecurities: number | null;
  minorityInterest: number | null;

  depreciationAmortization: number | null;
  capex: number | null;
  changeInNWC: number | null;
  stockBasedCompensation: number | null;
  acquisitions: number | null;
  assetDisposals: number | null;
  debtIssuance: number | null;
  debtRepayment: number | null;
  dividendsPaid: number | null;
  shareIssuance: number | null;
  shareRepurchases: number | null;

  revenue: number | null;
  ebit: number | null;
  ebitda: number | null;
  researchDevelopment: number | null;
  interestExpense: number | null;
  interestIncome: number | null;
  pretaxIncome: number | null;
  incomeTaxExpense: number | null;
  netIncome: number | null;
  restructuringCharges: number | null;

  revenueHistory: number[];
  ebitHistory: number[];
  researchDevelopmentHistory: number[];
  operatingLeaseAssetsHistory: number[];
  otherOperatingAssetsHistory: number[];
  otherOperatingLiabilitiesHistory: number[];

  /**
   * Which balance-sheet line and which column the cash balance was read from.
   * Cash drives the excess-cash add-back in the Ch. 14 bridge, and the choice
   * between the annual and the latest interim balance sheet is a judgment
   * call, so it is reported rather than left implicit.
   */
  cashSource: FieldSource | null;

  /** Field names that no alias resolved, for the data-quality panel. */
  unresolved: string[];
}

function emptyFacts(source: StatementFacts['source']): StatementFacts {
  return {
    source,
    accountingFramework: 'unknown',
    netPPE: null,
    workingCapital: null,
    goodwill: null,
    intangibles: null,
    totalAssets: null,
    totalEquity: null,
    currentAssets: null,
    currentLiabilities: null,
    shortTermDebt: null,
    otherOperatingAssets: null,
    otherOperatingLiabilities: null,
    cash: null,
    shortTermInvestments: null,
    longTermInvestments: null,
    equityInvestments: null,
    financialSubsidiaries: null,
    otherNonoperatingAssets: null,
    totalDebt: null,
    operatingLeaseLiabilities: null,
    currentLeaseLiabilities: null,
    operatingLeaseAssets: null,
    pensionObligations: null,
    restructuringReserves: null,
    overfundedPensionAssets: null,
    deferredTaxLiabilities: null,
    deferredTaxAssets: null,
    hybridSecurities: null,
    minorityInterest: null,
    depreciationAmortization: null,
    capex: null,
    changeInNWC: null,
    stockBasedCompensation: null,
    acquisitions: null,
    assetDisposals: null,
    debtIssuance: null,
    debtRepayment: null,
    dividendsPaid: null,
    shareIssuance: null,
    shareRepurchases: null,
    revenue: null,
    ebit: null,
    ebitda: null,
    researchDevelopment: null,
    interestExpense: null,
    interestIncome: null,
    pretaxIncome: null,
    incomeTaxExpense: null,
    netIncome: null,
    restructuringCharges: null,
    revenueHistory: [],
    ebitHistory: [],
    researchDevelopmentHistory: [],
    operatingLeaseAssetsHistory: [],
    otherOperatingAssetsHistory: [],
    otherOperatingLiabilitiesHistory: [],
    cashSource: null,
    unresolved: [],
  };
}

export interface EastmoneyStatementResult {
  companyName: string;
  fiscalYearEnd: string;
  facts: StatementFacts;
}

function finiteField(row: any, key: string): number | null {
  const value = row?.[key];
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function datedRows(rows: any[]): any[] {
  return rows
    .filter((row) => typeof row?.REPORT_DATE === 'string')
    .sort((a, b) => String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE)));
}

function annualRows(rows: any[]): any[] {
  return datedRows(rows).filter((row) => String(row.REPORT_DATE).slice(5, 10) === '12-31');
}

function sumFields(row: any, keys: string[]): number | null {
  const values = keys.map((key) => finiteField(row, key)).filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

/** Normalize Eastmoney's detailed China A-share statements for the valuation engine. */
export function eastmoneyFactsFromRows(
  incomeRows: any[],
  balanceRows: any[],
  cashFlowRows: any[]
): EastmoneyStatementResult | null {
  const annualIncome = annualRows(incomeRows);
  const annualCashFlow = annualRows(cashFlowRows);
  const balance = datedRows(balanceRows)[0] ?? null;
  const income = annualIncome[0] ?? null;
  const cashFlow = annualCashFlow[0] ?? null;
  if (!balance && !income && !cashFlow) return null;

  const f = emptyFacts('eastmoney');
  const currentAssets = finiteField(balance, 'TOTAL_CURRENT_ASSETS');
  const currentLiabilities = finiteField(balance, 'TOTAL_CURRENT_LIAB');
  f.netPPE = finiteField(balance, 'FIXED_ASSET');
  f.currentAssets = currentAssets;
  f.currentLiabilities = currentLiabilities;
  f.workingCapital =
    currentAssets !== null && currentLiabilities !== null ? currentAssets - currentLiabilities : null;
  f.totalAssets = finiteField(balance, 'TOTAL_ASSETS');
  f.totalEquity = finiteField(balance, 'TOTAL_EQUITY');
  f.cash = finiteField(balance, 'MONETARYFUNDS');
  f.cashSource = f.cash === null
    ? null
    : {
        field: 'MONETARYFUNDS',
        period: String(balance.REPORT_DATE).slice(0, 10),
        interim: String(balance.REPORT_DATE).slice(5, 10) !== '12-31',
      };
  f.totalDebt = sumFields(balance, ['SHORT_LOAN', 'LONG_LOAN', 'NONCURRENT_LIAB_1YEAR', 'BOND_PAYABLE']);
  f.operatingLeaseLiabilities = finiteField(balance, 'LEASE_LIAB');
  f.goodwill = finiteField(balance, 'GOODWILL');
  f.intangibles = finiteField(balance, 'INTANGIBLE_ASSET');
  f.minorityInterest = finiteField(balance, 'MINORITY_EQUITY');
  f.deferredTaxAssets = finiteField(balance, 'DEFER_TAX_ASSET');
  f.deferredTaxLiabilities = finiteField(balance, 'DEFER_TAX_LIAB');

  f.revenue = finiteField(income, 'TOTAL_OPERATE_INCOME');
  // Chinese operating profit is the closest consistently reported EBIT proxy.
  f.ebit = finiteField(income, 'OPERATE_PROFIT');
  f.pretaxIncome = finiteField(income, 'TOTAL_PROFIT');
  f.incomeTaxExpense = finiteField(income, 'INCOME_TAX');
  f.netIncome = finiteField(income, 'PARENT_NETPROFIT') ?? finiteField(income, 'NETPROFIT');
  const interestExpense = finiteField(income, 'FE_INTEREST_EXPENSE');
  f.interestExpense = interestExpense === null ? null : Math.abs(interestExpense);
  f.interestIncome = finiteField(income, 'FE_INTEREST_INCOME');

  f.depreciationAmortization = sumFields(cashFlow, [
    'FA_IR_DEPR',
    'IA_AMORTIZE',
    'LPE_AMORTIZE',
    'USERIGHT_ASSET_AMORTIZE',
  ]);
  const capex = finiteField(cashFlow, 'CONSTRUCT_LONG_ASSET');
  f.capex = capex === null ? null : Math.abs(capex);
  f.revenueHistory = annualIncome
    .map((row) => finiteField(row, 'TOTAL_OPERATE_INCOME'))
    .filter((value): value is number => value !== null);
  f.ebitHistory = annualIncome
    .map((row) => finiteField(row, 'OPERATE_PROFIT'))
    .filter((value): value is number => value !== null);
  if (f.ebit !== null && f.depreciationAmortization !== null) {
    f.ebitda = f.ebit + f.depreciationAmortization;
  }
  f.unresolved = unresolvedNames(f);

  const source = income ?? balance ?? cashFlow;
  return {
    companyName: typeof source?.SECURITY_NAME_ABBR === 'string' ? source.SECURITY_NAME_ABBR : '',
    fiscalYearEnd: typeof income?.REPORT_DATE === 'string' ? income.REPORT_DATE.slice(0, 10) : 'unknown',
    facts: f,
  };
}

function eastmoneyStatementUrl(symbol: string, suffix: string, reportName: string): string {
  const secucode = `${symbol}.${suffix === 'SZ' ? 'SZ' : 'SH'}`;
  const filter = encodeURIComponent(`(SECUCODE="${secucode}")`);
  return (
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=${reportName}` +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=12&sortTypes=-1` +
    '&sortColumns=REPORT_DATE&source=HSF10&client=PC'
  );
}

export async function eastmoneyStatementFacts(
  symbol: string,
  suffix: string
): Promise<EastmoneyStatementResult | null> {
  const rows = (payload: any): any[] => (Array.isArray(payload?.result?.data) ? payload.result.data : []);
  const fetchRows = async (statement: 'INCOME' | 'BALANCE' | 'CASHFLOW'): Promise<any[]> => {
    // Eastmoney separates financial-company statements into bank, securities,
    // and insurer schemas. Most issuers use the general schema, so only probe
    // the alternatives when the preceding schema is empty.
    for (const schema of ['G', 'B', 'S', 'I']) {
      const payload = await getJson(
        eastmoneyStatementUrl(symbol, suffix, `RPT_F10_FINANCE_${schema}${statement}`)
      );
      const result = rows(payload);
      if (result.length > 0) return result;
    }
    return [];
  };
  const [income, balance, cashFlow] = await Promise.all([
    fetchRows('INCOME'),
    fetchRows('BALANCE'),
    fetchRows('CASHFLOW'),
  ]);
  return eastmoneyFactsFromRows(income, balance, cashFlow);
}

/**
 * Fetch the balance sheet, cash flow statement and income statement for a
 * stockanalysis.com listing and normalize them into StatementFacts.
 */
export async function saStatementFacts(listing: SaListing, accountingFramework: AccountingFramework = 'unknown'): Promise<StatementFacts> {
  const [bs, cf, is] = await Promise.all([
    fetchStatementTable(listing, 'balance-sheet'),
    fetchStatementTable(listing, 'cash-flow-statement'),
    fetchStatementTable(listing, 'income-statement'),
  ]);

  const f = emptyFacts('stockanalysis');
  f.accountingFramework = accountingFramework;

  // Balance-sheet levels: prefer the most recent column even when it is a
  // current/TTM snapshot, since a stock figure has no annualization problem.
  f.netPPE = latestIncludingTtm(bs, A.netPPE);
  f.workingCapital = latestIncludingTtm(bs, A.workingCapital);
  if (f.workingCapital === null) {
    const ca = latestIncludingTtm(bs, A.currentAssets);
    const cl = latestIncludingTtm(bs, A.currentLiabilities);
    if (ca !== null && cl !== null) f.workingCapital = ca - cl;
  }
  f.goodwill = latestIncludingTtm(bs, A.goodwill) ?? latestIncludingTtm(bs, A.goodwillAndIntangibles);
  f.intangibles = latestIncludingTtm(bs, A.intangibles);
  f.totalAssets = latestIncludingTtm(bs, A.totalAssets);
  f.totalEquity = latestIncludingTtm(bs, A.totalEquity);
  f.currentAssets = latestIncludingTtm(bs, A.currentAssets);
  f.currentLiabilities = latestIncludingTtm(bs, A.currentLiabilities);
  f.shortTermDebt = latestIncludingTtm(bs, A.shortTermDebt);
  f.otherOperatingAssets = latestIncludingTtm(bs, A.otherOperatingAssets);
  f.otherOperatingLiabilities = latestIncludingTtm(bs, A.otherOperatingLiabilities);
  // Cash: the latest balance sheet wins whether it is the fiscal year end or a
  // more recent interim column, since a stock figure is as of a date and the
  // freshest one is the most relevant to today's bridge. Which it was gets
  // recorded so the data-quality panel can say so.
  f.shortTermInvestments = latestIncludingTtm(bs, A.shortTermInvestments);
  const cashRes = resolveLatest(bs, A.cash);
  if (cashRes !== null) {
    f.cash = cashRes.value;
    f.cashSource = { field: cashRes.field, period: cashRes.period, interim: cashRes.interim };
  } else {
    // Some listings only report the combined "cash and investments" line. It
    // already contains short-term investments, so net them out here rather
    // than counting them twice when excess cash is built.
    const combined = resolveLatest(bs, A.cashAndInvestments);
    if (combined !== null) {
      f.cash = combined.value - (f.shortTermInvestments ?? 0);
      f.cashSource = {
        field: `${combined.field} less short-term investments`,
        period: combined.period,
        interim: combined.interim,
      };
    }
  }
  f.longTermInvestments = latestIncludingTtm(bs, A.longTermInvestments);
  f.equityInvestments = latestIncludingTtm(bs, A.equityInvestments);
  f.financialSubsidiaries = latestIncludingTtm(bs, A.financialSubsidiaries);
  f.otherNonoperatingAssets = latestIncludingTtm(bs, A.otherNonoperatingAssets);
  f.totalDebt = latestIncludingTtm(bs, A.totalDebt);
  if (f.totalDebt === null) {
    const sd = latestIncludingTtm(bs, A.shortTermDebt);
    const ld = latestIncludingTtm(bs, A.longTermDebt);
    if (sd !== null || ld !== null) f.totalDebt = (sd ?? 0) + (ld ?? 0);
  }
  f.operatingLeaseLiabilities = latestIncludingTtm(bs, A.operatingLeaseLiabilities);
  f.currentLeaseLiabilities = latestIncludingTtm(bs, A.currentLeaseLiabilities);
  if (f.operatingLeaseLiabilities === null) {
    const currentLease = f.currentLeaseLiabilities;
    const longLease = latestIncludingTtm(bs, A.longTermLeaseLiabilities);
    if (currentLease !== null || longLease !== null) f.operatingLeaseLiabilities = (currentLease ?? 0) + (longLease ?? 0);
  }
  f.operatingLeaseAssets = latestIncludingTtm(bs, A.operatingLeaseAssets);
  f.pensionObligations = latestIncludingTtm(bs, A.pensionObligations);
  f.restructuringReserves = latestIncludingTtm(bs, A.restructuringReserves);
  f.overfundedPensionAssets = latestIncludingTtm(bs, A.overfundedPensionAssets);
  f.deferredTaxLiabilities = latestIncludingTtm(bs, A.deferredTaxLiabilities);
  f.deferredTaxAssets = latestIncludingTtm(bs, A.deferredTaxAssets);
  f.hybridSecurities = latestIncludingTtm(bs, A.hybridSecurities);
  f.minorityInterest = latestIncludingTtm(bs, A.minorityInterest);

  // Cash-flow and income-statement flows: fiscal year only, so a TTM column
  // never gets mixed with annual figures.
  f.depreciationAmortization = latest(cf, A.depreciationAmortization);
  const capex = latest(cf, A.capex);
  f.capex = capex === null ? null : Math.abs(capex);
  f.changeInNWC = latest(cf, A.changeInNWC);
  f.stockBasedCompensation = latest(cf, A.stockBasedCompensation);
  f.acquisitions = latest(cf, A.acquisitions);
  f.assetDisposals = latest(cf, A.assetDisposals);
  f.debtIssuance = latest(cf, A.debtIssuance);
  f.debtRepayment = latest(cf, A.debtRepayment);
  f.dividendsPaid = latest(cf, A.dividendsPaid);
  f.shareIssuance = latest(cf, A.shareIssuance);
  f.shareRepurchases = latest(cf, A.shareRepurchases);

  f.revenue = latest(is, A.revenue);
  f.ebit = latest(is, A.ebit);
  f.ebitda = latest(is, A.ebitda);
  f.researchDevelopment = latest(is, A.researchDevelopment);
  const intExp = latest(is, A.interestExpense);
  f.interestExpense = intExp === null ? null : Math.abs(intExp);
  f.interestIncome = latest(is, A.interestIncome);
  f.pretaxIncome = latest(is, A.pretaxIncome);
  f.incomeTaxExpense = latest(is, A.incomeTaxExpense);
  // The cash flow statement opens with net income by construction, so it is a
  // sound second source when the income statement page returns nothing — which
  // is not hypothetical: HSBC's income-statement payload comes back empty while
  // its cash-flow payload carries netIncomeCF. For a bank this is the figure the
  // whole equity model runs on, so it is worth the second look.
  f.netIncome = latest(is, A.netIncome) ?? latest(cf, A.netIncomeCashFlow);
  f.restructuringCharges = latest(is, A.restructuringCharges);

  f.revenueHistory = numericSeries(is, A.revenue) ?? [];
  f.ebitHistory = numericSeries(is, A.ebit) ?? [];
  f.researchDevelopmentHistory = numericSeries(is, A.researchDevelopment) ?? [];
  f.operatingLeaseAssetsHistory = numericSeries(bs, A.operatingLeaseAssets) ?? [];
  f.otherOperatingAssetsHistory = numericSeries(bs, A.otherOperatingAssets) ?? [];
  f.otherOperatingLiabilitiesHistory = numericSeries(bs, A.otherOperatingLiabilities) ?? [];

  f.unresolved = unresolvedNames(f);
  return f;
}

function unresolvedNames(f: StatementFacts): string[] {
  const watch: (keyof StatementFacts)[] = [
    'netPPE',
    'workingCapital',
    'depreciationAmortization',
    'changeInNWC',
    'researchDevelopment',
    'operatingLeaseLiabilities',
    'pretaxIncome',
    'incomeTaxExpense',
    'interestExpense',
  ];
  return watch.filter((k) => f[k] === null).map(String);
}

/**
 * What each statement page actually returned, for the health endpoint. Field
 * naming on stockanalysis.com is not a documented contract, so when a figure
 * comes back missing the only way to tell a failed fetch from an unrecognized
 * alias is to look at the field names the payload really carries.
 */
export interface StatementProbe {
  kind: StatementKind;
  fetched: boolean;
  fieldCount: number;
  fields: string[];
  periods: string[];
  leadingTtm: boolean;
}

export async function probeStatements(listing: SaListing): Promise<{
  tables: StatementProbe[];
  cash: ResolvedValue | null;
  cashAndInvestments: ResolvedValue | null;
  shortTermInvestments: ResolvedValue | null;
}> {
  const kinds: StatementKind[] = ['balance-sheet', 'income-statement', 'cash-flow-statement'];
  const fetched = await Promise.all(kinds.map((k) => fetchStatementTable(listing, k)));
  const tables: StatementProbe[] = kinds.map((kind, i) => {
    const t = fetched[i];
    return {
      kind,
      fetched: t !== null,
      fieldCount: t === null ? 0 : Object.keys(t.fields).length,
      fields: t === null ? [] : Object.keys(t.fields),
      periods: t === null ? [] : t.periods.slice(0, 5),
      leadingTtm: t?.leadingTtm ?? false,
    };
  });
  const bs = fetched[0];
  return {
    tables,
    cash: resolveLatest(bs, A.cash),
    cashAndInvestments: resolveLatest(bs, A.cashAndInvestments),
    shortTermInvestments: resolveLatest(bs, A.shortTermInvestments),
  };
}

/** Build the same shape from an already-extracted EDGAR fact set. */
export function factsFromEdgar(e: Partial<Omit<StatementFacts, 'source' | 'unresolved'>>): StatementFacts {
  const f = emptyFacts('edgar');
  Object.assign(f, e);
  f.unresolved = unresolvedNames(f);
  return f;
}
