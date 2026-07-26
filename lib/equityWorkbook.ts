// The workbook for a bank or insurer, mirroring the equity cash flow model in
// Koller, Goedhart & Wessels, Part 5 ("Valuing Banks").
//
// It is a separate builder rather than a branch inside the enterprise workbook
// because almost nothing carries over. There is no NOPAT sheet, no invested
// capital, no free cash flow, no WACC and no equity bridge: for a bank those
// concepts do not exist. What replaces them is a single chain -- book equity
// earns a return, part of the earnings are retained to grow the capital base,
// the rest is what shareholders can take out -- and the sheets below follow
// that chain in order.
//
// Every arithmetic step is written as a live Excel formula referencing the
// cells above it, so a reader can change the return on equity or the growth
// rate in the sheet and watch the valuation move. That is the point of the
// export: the page shows the answer, the workbook shows the working.

import { Cell, Sheet } from './xlsx';
import { DataQualityRow, DcfAssumptions, Financials } from './types';
import { EquityDcfResult } from './equityDcf';

export interface EquityValuationPayload {
  financials: Financials;
  assumptions: DcfAssumptions;
  equityValuation: EquityDcfResult;
  dataQuality: DataQualityRow[];
}

const CONFIDENCE_LABEL: Record<DataQualityRow['confidence'], string> = {
  source: 'From filing',
  derived: 'Calculated',
  estimated: 'Estimated',
  default: 'Assumption',
};

const money = (v: number): Cell => (Number.isFinite(v) ? { v, s: 'money' } : { v: 'n/a' });
const money2 = (v: number): Cell => (Number.isFinite(v) ? { v, s: 'money2' } : { v: 'n/a' });
const pct = (v: number): Cell => (Number.isFinite(v) ? { v, s: 'pct' } : { v: 'n/a' });
const mult = (v: number): Cell => (Number.isFinite(v) ? { v, s: 'mult' } : { v: 'n/a' });
const bold = (v: string | number): Cell => ({ v, s: 'bold' });
const title = (v: string): Cell => ({ v, s: 'title' });
const section = (v: string): Cell => ({ v, s: 'section' });
const note = (v: string): Cell => ({ v, s: 'note' });

/** Zero-based column index to spreadsheet letter. */
function col(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function sheetHeader(p: EquityValuationPayload, name: string, chapter: string): Cell[][] {
  const f = p.financials;
  return [
    [title(`${f.companyName} (${f.ticker}) — ${name}`)],
    [
      note(
        `${chapter} · ${f.marketName} · fiscal year end ${f.fiscalYearEnd} · all figures in ${f.currency}, as reported (not scaled)`
      ),
    ],
    [],
  ];
}

/** One column per forecast year, plus the label and opening-position columns. */
const YEAR_COLS = (p: EquityValuationPayload) => [36, 16, ...p.equityValuation.forecast.map(() => 14)];

// Every sheet opens with the same three-row header block, so the row addresses
// below are fixed by the order the rows are pushed. They are named here rather
// than inlined because the valuation sheet points formulas at them across
// sheets: change the push order on a sheet and you change it here too, which is
// the whole reason for not writing "!B9" at the call site.
const HEADER_ROWS = 3;
const ECF = {
  sheet: "'Equity cash flow'",
  header: HEADER_ROWS + 1,
  opening: HEADER_ROWS + 2,
  roe: HEADER_ROWS + 3,
  netIncome: HEADER_ROWS + 4,
  growth: HEADER_ROWS + 5,
  invest: HEADER_ROWS + 6,
  ecf: HEADER_ROWS + 7,
};
const COE = {
  sheet: "'Cost of equity'",
  header: HEADER_ROWS + 1,
  riskFree: HEADER_ROWS + 2,
  erp: HEADER_ROWS + 3,
  beta: HEADER_ROWS + 4,
  crp: HEADER_ROWS + 5,
  ke: HEADER_ROWS + 6,
};

// ---------------------------------------------------------------------------

function summarySheet(p: EquityValuationPayload): Sheet {
  const { financials: f, equityValuation: e } = p;
  // The first forecast year opens on the reported book equity, so the schedule
  // carries the figure and it does not have to be backed out of a ratio.
  const bookEquity = e.forecast.length ? e.forecast[0].openingEquity : NaN;
  const rows: Cell[][] = [
    ...sheetHeader(p, 'Valuation summary', 'Koller Part 5 · equity cash flow model'),
    [
      note(
        'This filer was identified as a bank or insurer, so it is valued by discounting equity cash flow at the cost of equity rather than free cash flow at the WACC. For a bank, deposits and wholesale funding are raw material rather than financing, so invested capital, NOPAT, free cash flow and the WACC all lose their meaning.'
      ),
    ],
    [],
    [section('Verdict'), section('')],
    ['Market price', money2(e.marketPrice)],
    ['Equity DCF fair value per share', money2(e.fairValuePerShare)],
    ['Gap vs market', pct(e.valuationGapPct)],
    ['Verdict', e.verdict],
    [],
    [section('Key value drivers'), section('')],
    ['Return on equity (current)', pct(e.returnOnEquity)],
    ['Return on equity (terminal)', pct(e.terminalReturnOnEquity)],
    ['Cost of equity', pct(e.costOfEquity)],
    ['ROE less cost of equity', pct(e.returnOnEquity - e.costOfEquity)],
    ['Growth in the capital base (explicit years)', pct(e.growth)],
    ['Long-run growth', pct(e.terminalGrowth)],
    [
      note(
        e.returnOnEquity >= e.costOfEquity
          ? 'Return on equity exceeds the cost of equity: growing the balance sheet creates value.'
          : 'Return on equity is below the cost of equity: growing the balance sheet destroys value, and the bank is worth less than its book equity.'
      ),
    ],
    [],
    [section('Value build-up'), section('')],
    ['PV of explicit equity cash flow', money(e.pvExplicitEquityCashFlow)],
    ['PV of continuing value', money(e.pvContinuingValue)],
    [bold('Equity value'), { v: e.equityValue, s: 'total' }],
    ['Continuing value share of equity value', pct(e.equityValue ? e.pvContinuingValue / e.equityValue : NaN)],
    ['Shares outstanding', { v: f.sharesOutstanding, s: 'money' }],
    [bold('Fair value per share'), money2(e.fairValuePerShare)],
    [],
    [section('Cross-check: price to book'), section('')],
    ['Common book equity', money(bookEquity)],
    ['Book value per share', money2(f.sharesOutstanding ? bookEquity / f.sharesOutstanding : NaN)],
    ['Implied price / book', mult(e.impliedPriceToBook)],
    ['Market price / book', mult(e.marketPriceToBook)],
    [
      note(
        'Price to book is the natural multiple for a bank, because book equity is the capital the earnings are generated on. A model that returns a price-to-book far from the market is making a different assumption about return on equity, not about growth.'
      ),
    ],
  ];

  if (e.warnings.length > 0) {
    rows.push([], [section('Warnings'), section('')]);
    for (const w of e.warnings) rows.push([note(w)]);
  }

  return { name: 'Summary', cols: [46, 20], rows };
}

function costOfEquitySheet(p: EquityValuationPayload): Sheet {
  const { assumptions: a, equityValuation: e } = p;
  const rows: Cell[][] = [...sheetHeader(p, 'Cost of equity', 'Koller Ch. 13 · beta per Ch. 15')];

  const rfRow = COE.riskFree;
  const erpRow = COE.erp;
  const betaRow = COE.beta;
  const crpRow = COE.crp;

  rows.push([{ v: 'Cost of equity (CAPM)', s: 'header' }, { v: 'Input', s: 'header' }]);
  rows.push(['Risk-free rate', pct(a.riskFreeRate)]);
  rows.push(['Equity risk premium', pct(a.equityRiskPremium)]);
  rows.push(['Beta', { v: a.beta, s: 'money2' }]);
  rows.push(['Country risk premium', pct(a.countryRiskPremium)]);
  rows.push([
    bold('Cost of equity'),
    { v: e.costOfEquity, s: 'pct', f: `B${rfRow}+B${betaRow}*B${erpRow}+B${crpRow}` },
  ]);
  rows.push([]);
  rows.push([
    note(
      "Koller Ch. 15: the beta above is the bank's levered beta used directly. It is deliberately not unlevered and relevered, because a bank's leverage is operating rather than financial — relevering at a bank's debt-to-equity ratio of eight or ten would produce a beta above three and a cost of equity near twenty per cent, which is an artefact of applying an industrial formula to a balance sheet it was never meant for."
    ),
  ]);
  rows.push([
    note(
      'There is no WACC in this workbook and no cost of debt. Interest paid to depositors is an operating cost inside net income, so it has already been charged before the cash flow being discounted.'
    ),
  ]);

  return { name: 'Cost of equity', cols: [44, 18], rows };
}

function equityCashFlowSheet(p: EquityValuationPayload): Sheet {
  const e = p.equityValuation;
  const fc = e.forecast;
  const rows: Cell[][] = [...sheetHeader(p, 'Equity cash flow', 'Koller Part 5')];

  rows.push([
    { v: 'Equity cash flow', s: 'header' },
    { v: 'Rate', s: 'header' },
    ...fc.map((y) => ({ v: `Y${y.year}`, s: 'header' as const })),
  ]);

  const openingRow = ECF.opening;
  const roeRow = ECF.roe;
  const niRow = ECF.netIncome;
  const growthRow = ECF.growth;
  const investRow = ECF.invest;
  const ecfRow = ECF.ecf;

  // Year 1 opens on the reported book equity — a hard input. Every later year
  // rolls forward from the year before it, so a reader who changes the growth
  // rate moves the whole capital base rather than only the first year's income.
  // The increase row is written as a negative (it is a use of cash), hence the
  // subtraction here.
  rows.push([
    'Opening book equity',
    { v: null },
    ...fc.map((y, i) =>
      i === 0
        ? money(y.openingEquity)
        : { v: y.openingEquity, s: 'money' as const, f: `${col(i + 1)}${openingRow}-${col(i + 1)}${investRow}` }
    ),
  ]);
  rows.push(['Return on equity', pct(e.returnOnEquity), ...fc.map((y) => pct(y.returnOnEquity))]);
  rows.push([
    'Net income',
    { v: null },
    ...fc.map((y, i) => ({
      v: y.netIncome,
      s: 'money' as const,
      f: `${col(i + 2)}${openingRow}*$B$${roeRow}`,
    })),
  ]);
  rows.push(['Growth in the capital base', pct(e.growth), ...fc.map(() => pct(e.growth))]);
  rows.push([
    'Increase in book equity',
    { v: null },
    ...fc.map((y, i) => ({
      v: -y.equityInvestment,
      s: 'money' as const,
      f: `-${col(i + 2)}${openingRow}*$B$${growthRow}`,
    })),
  ]);
  rows.push([
    bold('Equity cash flow'),
    { v: null },
    ...fc.map((y, i) => ({
      v: y.equityCashFlow,
      s: 'total' as const,
      f: `${col(i + 2)}${niRow}+${col(i + 2)}${investRow}`,
    })),
  ]);
  const dfRow = rows.length + 1;
  rows.push(['Discount factor', { v: null }, ...fc.map((y) => ({ v: y.discountFactor, s: 'money2' as const }))]);
  const pvRow = rows.length + 1;
  rows.push([
    bold('Present value'),
    { v: null },
    ...fc.map((y, i) => ({
      v: y.presentValue,
      s: 'total' as const,
      f: `${col(i + 2)}${ecfRow}*${col(i + 2)}${dfRow}`,
    })),
  ]);
  rows.push([]);
  rows.push([
    bold('PV of explicit equity cash flow'),
    { v: e.pvExplicitEquityCashFlow, s: 'money', f: `SUM(C${pvRow}:${col(fc.length + 1)}${pvRow})` },
  ]);
  rows.push([]);
  rows.push([
    note(
      'Equity cash flow is net income less the increase in book equity. A bank cannot grow its balance sheet without growing the regulatory capital behind it, so growth of g requires equity to grow by g as well; only what is left over can be paid out.'
    ),
  ]);
  rows.push([
    note(
      'Discounting is end of year, not mid year. Equity cash flow to a bank is dominated by dividends and capital actions that fall at period ends, and end-of-year discounting makes the model reconcile exactly to book value when return on equity equals the cost of equity — which is this model\u2019s sharpest internal audit.'
    ),
  ]);
  rows.push([
    note(
      `Row ${niRow} and row ${investRow} are live formulas against the return on equity in B${roeRow} and the growth rate in B${growthRow}. Change either and the whole schedule, and the valuation on the next sheet, recalculate.`
    ),
  ]);

  return { name: 'Equity cash flow', cols: YEAR_COLS(p), rows };
}

function valuationSheet(p: EquityValuationPayload): Sheet {
  const { financials: f, equityValuation: e } = p;
  const rows: Cell[][] = [...sheetHeader(p, 'Equity valuation', 'Koller Part 5 · continuing value per Ch. 12')];

  const closingEquity = e.forecast.length
    ? e.forecast[e.forecast.length - 1].openingEquity * (1 + e.growth)
    : NaN;
  const netIncomeNext = closingEquity * e.terminalReturnOnEquity;
  const retention = e.terminalReturnOnEquity > 0 ? e.terminalGrowth / e.terminalReturnOnEquity : NaN;

  // The last forecast column on the cash flow sheet, so closing equity is read
  // off that schedule rather than restated here. Without the link, changing the
  // growth rate there would move net income but leave the continuing value
  // sitting on a capital base that no longer exists.
  const lastEcfCol = col(e.forecast.length + 1);

  rows.push([section('Continuing value'), section('')]);
  const closingRow = rows.length + 1;
  rows.push([
    'Book equity at the end of the forecast',
    e.forecast.length
      ? {
          v: closingEquity,
          s: 'money' as const,
          f: `${ECF.sheet}!${lastEcfCol}${ECF.opening}-${ECF.sheet}!${lastEcfCol}${ECF.invest}`,
        }
      : money(closingEquity),
  ]);
  const troeRow = rows.length + 1;
  rows.push(['Terminal return on equity', pct(e.terminalReturnOnEquity)]);
  const niNextRow = rows.length + 1;
  rows.push(['Net income in the first year after the forecast', { v: netIncomeNext, s: 'money', f: `B${closingRow}*B${troeRow}` }]);
  const gRow = rows.length + 1;
  rows.push(['Long-run growth', pct(e.terminalGrowth)]);
  const retentionRow = rows.length + 1;
  rows.push(['Retention rate (g / ROE)', { v: retention, s: 'pct', f: `B${gRow}/B${troeRow}` }]);
  const keRow = rows.length + 1;
  rows.push([
    'Cost of equity',
    { v: e.costOfEquity, s: 'pct', f: `${COE.sheet}!B${COE.ke}` },
  ]);
  const cvRow = rows.length + 1;
  rows.push([
    bold('Continuing value at the end of the forecast'),
    { v: e.continuingValue, s: 'total', f: `B${niNextRow}*(1-B${retentionRow})/(B${keRow}-B${gRow})` },
  ]);
  const pvCvRow = rows.length + 1;
  rows.push([
    'PV of continuing value',
    { v: e.pvContinuingValue, s: 'money', f: `B${cvRow}/(1+B${keRow})^${e.forecast.length}` },
  ]);
  rows.push([]);

  rows.push([section('Equity value'), section('')]);
  const pvExplicitRow = rows.length + 1;
  rows.push(['PV of explicit equity cash flow', money(e.pvExplicitEquityCashFlow)]);
  // Restated from the continuing-value block above rather than repeated as a
  // constant, so the two halves of the sheet cannot drift apart if the reader
  // edits the terminal assumptions.
  rows.push(['PV of continuing value', { v: e.pvContinuingValue, s: 'money', f: `B${pvCvRow}` }]);
  const equityRow = rows.length + 1;
  rows.push([
    bold('Equity value'),
    { v: e.equityValue, s: 'total', f: `B${pvExplicitRow}+B${pvExplicitRow + 1}` },
  ]);
  const sharesRow = rows.length + 1;
  rows.push(['Shares outstanding', { v: f.sharesOutstanding, s: 'money' }]);
  rows.push([
    bold('Fair value per share'),
    { v: e.fairValuePerShare, s: 'money2', f: `B${equityRow}/B${sharesRow}` },
  ]);
  rows.push(['Market price', money2(e.marketPrice)]);
  rows.push(['Gap vs market', pct(e.valuationGapPct)]);
  rows.push([]);
  rows.push([
    note(
      `Key value driver formula in its equity form (Ch. 12): CV = NI(T+1) x (1 - g / ROE) / (Ke - g), with g = ${(
        e.terminalGrowth * 100
      ).toFixed(1)}%, terminal ROE = ${(e.terminalReturnOnEquity * 100).toFixed(1)}% and Ke = ${(
        e.costOfEquity * 100
      ).toFixed(1)}%. The reinvestment rate g / ROE is the same identity as the enterprise model's g / RONIC, with return on equity in place of return on invested capital.`
    ),
  ]);
  rows.push([
    note(
      'There is no bridge from enterprise value to equity value on this sheet, and that is not an omission: discounting equity cash flow at the cost of equity produces the value of equity directly, so there is no enterprise value to bridge from.'
    ),
  ]);
  rows.push([
    note(
      `Cell B${cvRow} is the live continuing-value formula. Set the terminal return on equity in B${troeRow} equal to the cost of equity in B${keRow} and the model collapses to book equity plus the excess returns of the explicit years — the competitive-equilibrium case, and the most conservative reading available here.`
    ),
  ]);

  return { name: 'Equity valuation', cols: [50, 20], rows };
}

function analysisSheet(p: EquityValuationPayload): Sheet {
  const e = p.equityValuation;
  const s = e.sensitivity;
  const rows: Cell[][] = [...sheetHeader(p, 'Analysis of results', 'Koller Ch. 15 and 16')];

  rows.push([section('Sensitivity: fair value per share'), section('')]);
  rows.push([
    { v: 'Cost of equity down / growth across', s: 'header' },
    ...s.growthValues.map((g) => ({ v: g, s: 'pct' as const })),
  ]);
  s.waccValues.forEach((w, i) => {
    rows.push([{ v: w, s: 'pct' }, ...s.growthValues.map((_, j) => money2(s.fairValues[i][j]))]);
  });
  rows.push([
    note(
      `Base case: cost of equity ${(s.baseWacc * 100).toFixed(1)}%, long-run growth ${(s.baseGrowth * 100).toFixed(
        1
      )}%. The terminal return on equity is held at ${(e.terminalReturnOnEquity * 100).toFixed(
        1
      )}% across the grid, so the centre cell equals the headline fair value. Cells reading n/a are combinations where growth is too close to the cost of equity for the perpetuity formula to mean anything.`
    ),
  ]);
  rows.push([]);

  rows.push([section('Price to book'), section('')]);
  rows.push(['Implied price / book', mult(e.impliedPriceToBook)]);
  rows.push(['Market price / book', mult(e.marketPriceToBook)]);
  rows.push([
    note(
      'Koller Ch. 16: a multiple is a cross-check on the model, not a substitute for it. For a bank the relevant one is price to book, because the earnings that drive the valuation are earned on the book capital.'
    ),
  ]);
  rows.push([]);

  rows.push([section('What the market is assuming'), section('')]);
  rows.push([
    note(
      `At the traded price of ${Number.isFinite(e.marketPrice) ? e.marketPrice.toFixed(2) : 'n/a'} the market is paying ${
        Number.isFinite(e.marketPriceToBook) ? e.marketPriceToBook.toFixed(2) : 'n/a'
      }x book against this model's ${
        Number.isFinite(e.impliedPriceToBook) ? e.impliedPriceToBook.toFixed(2) : 'n/a'
      }x. The gap is a statement about return on equity, growth, or both. The sensitivity grid above flexes the cost of equity and growth; to flex the return on equity instead, change the terminal rate on the Equity valuation sheet and watch the continuing value move.`
    ),
  ]);

  return { name: 'Analysis of results', cols: [36, 16, 16, 16, 16, 16], rows };
}

function assumptionsSheet(p: EquityValuationPayload): Sheet {
  const { assumptions: a, dataQuality, equityValuation: e } = p;
  const rows: Cell[][] = [
    ...sheetHeader(p, 'Assumptions and data quality', 'Inputs behind every number in this workbook'),
  ];

  rows.push([section('Assumptions'), section('')]);
  const entries: [string, Cell][] = [
    ['Risk-free rate', pct(a.riskFreeRate)],
    ['Equity risk premium', pct(a.equityRiskPremium)],
    ['Country risk premium', pct(a.countryRiskPremium)],
    ['Beta', { v: a.beta, s: 'money2' }],
    ['Cost of equity', pct(e.costOfEquity)],
    ['Explicit forecast years', a.explicitYears],
    ['Growth in the capital base', pct(e.growth)],
    ['Long-run growth', pct(e.terminalGrowth)],
    ['Return on equity (current)', pct(e.returnOnEquity)],
    ['Return on equity (terminal)', pct(e.terminalReturnOnEquity)],
    ['Discounting convention', 'end of year'],
  ];
  for (const [label, value] of entries) rows.push([label, value]);
  rows.push([]);
  rows.push([
    note(
      'The enterprise assumptions — operating tax rate, cost of debt, RONIC, mid-year discounting — are absent because the equity model uses none of them.'
    ),
  ]);
  rows.push([]);

  rows.push([section('Data quality'), section(''), section(''), section('')]);
  rows.push([
    { v: 'Input', s: 'header' },
    { v: 'Value used', s: 'header' },
    { v: 'Basis', s: 'header' },
    { v: 'Confidence', s: 'header' },
  ]);
  for (const row of dataQuality) {
    rows.push([row.field, row.value, row.basis, CONFIDENCE_LABEL[row.confidence]]);
  }
  rows.push([]);
  rows.push([note('Anything marked Estimated or Assumption was not read from a filing. Those are the inputs to challenge first.')]);

  return { name: 'Assumptions & sources', cols: [40, 26, 70, 16], rows };
}

// ---------------------------------------------------------------------------

export function buildEquityWorkbook(p: EquityValuationPayload): Sheet[] {
  return [
    summarySheet(p),
    costOfEquitySheet(p),
    equityCashFlowSheet(p),
    valuationSheet(p),
    analysisSheet(p),
    assumptionsSheet(p),
  ];
}

export function equityWorkbookFileName(f: Financials): string {
  const safeTicker = f.ticker.replace(/[^A-Za-z0-9.-]/g, '_');
  return `${safeTicker}_equity_DCF_valuation.xlsx`;
}
