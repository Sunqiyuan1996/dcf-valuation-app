// Builds the exported workbook with the sheet-by-sheet structure the Koller /
// Goedhart / Wessels model uses: reorganized statements first, then the value
// drivers, then the two equivalent valuations (DCF and economic profit), then
// the bridge to value per share, then the analysis of results.
//
// Pure data-in / sheets-out so it can be unit tested without a request.

import { Cell, Sheet } from './xlsx';
import {
  DataQualityRow,
  DcfAssumptions,
  DcfResult,
  Financials,
  Reorganization,
} from './types';

export interface ValuationPayload {
  financials: Financials;
  assumptions: DcfAssumptions;
  result: DcfResult;
  reorganization: Reorganization;
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

/** Header row that repeats on every year-column sheet. */
function yearHeader(p: ValuationPayload, first: string): Cell[] {
  return [
    { v: first, s: 'header' },
    { v: `Base ${p.financials.fiscalYearEnd}`, s: 'header' },
    ...p.result.forecast.map((y) => ({ v: `Y${y.year}`, s: 'header' as const })),
  ];
}

const YEAR_COLS = (p: ValuationPayload) => [34, 16, ...p.result.forecast.map(() => 14)];

function sheetHeader(p: ValuationPayload, name: string, chapter: string): Cell[][] {
  const f = p.financials;
  return [
    [title(`${f.companyName} (${f.ticker}) — ${name}`)],
    [note(`${chapter} · ${f.marketName} · fiscal year end ${f.fiscalYearEnd} · all figures in ${f.currency}, as reported (not scaled)`)],
    [],
  ];
}

// ---------------------------------------------------------------------------

function summarySheet(p: ValuationPayload): Sheet {
  const { financials: f, result: r, assumptions: a } = p;
  const rows: Cell[][] = [
    ...sheetHeader(p, 'Valuation summary', 'Koller Ch. 8 value-driver framework'),
    [section('Verdict'), section('')],
    ['Market price', money2(r.marketPrice)],
    ['DCF fair value per share', money2(r.fairValuePerShare)],
    ['Gap vs market', pct(r.valuationGapPct)],
    ['Verdict', r.verdict],
    [],
    [section('Key value drivers'), section('')],
    ['Revenue growth (stage 1)', pct(a.stage1RevenueGrowth)],
    ['Long-run growth', pct(a.terminalGrowth)],
    ['Return on invested capital (current)', pct(r.economicProfit.currentRoic)],
    ['Return on new invested capital (stage 1)', pct(a.stage1IncrementalRoic)],
    ['Return on new invested capital (terminal)', pct(a.terminalIncrementalRoic)],
    ['WACC', pct(r.wacc)],
    ['ROIC less WACC', pct(r.economicProfit.roicSpread)],
    [
      note(
        r.economicProfit.roicSpread >= 0
          ? 'ROIC exceeds WACC: growth creates value.'
          : 'ROIC is below WACC: growth destroys value — faster growth lowers the valuation.'
      ),
    ],
    [],
    [section('Value build-up'), section('')],
    ['PV of explicit + fade free cash flow', money(r.pvExplicitFcf)],
    ['PV of continuing value', money(r.pvContinuingValue)],
    ['Enterprise value', money(r.enterpriseValue)],
    ['Continuing value share of enterprise value', pct(r.continuingValueDiagnostics.cvShareOfEnterpriseValue)],
    ['Equity value', money(r.equityValue)],
    ['Shares outstanding', { v: f.sharesOutstanding, s: 'money' }],
    [bold('Fair value per share'), money2(r.fairValuePerShare)],
    [],
    [section('Cross-checks'), section('')],
    ['Enterprise value, economic-profit method', money(r.economicProfit.enterpriseValue)],
    ['Reconciliation error vs DCF', pct(r.economicProfit.reconciliationError)],
    ['DCF implied EV/EBIT', mult(r.impliedMultiples.dcfEvToEbit)],
    ['Market EV/EBIT', mult(r.impliedMultiples.marketEvToEbit)],
  ];

  if (f.isFinancial) {
    rows.push([], [bold('Warning: this filer looks like a bank or insurer.')], [
      note('For financial institutions debt is raw material rather than financing, so enterprise DCF and invested capital are not meaningful (Koller Part 5). Treat this workbook as illustrative only.'),
    ]);
  }

  return { name: 'Summary', cols: [44, 18], rows };
}

function nopatSheet(p: ValuationPayload): Sheet {
  const { financials: f, result: r, assumptions: a } = p;
  const fc = r.forecast;
  return {
    name: 'NOPAT',
    cols: YEAR_COLS(p),
    rows: [
      ...sheetHeader(p, 'Reorganized income statement', 'Koller Ch. 9 · operating taxes per Ch. 18'),
      yearHeader(p, 'Reorganized income statement'),
      ['Revenue', money(f.revenue), ...fc.map((y) => money(y.revenue))],
      ['Revenue growth', { v: null }, ...fc.map((y) => pct(y.growth))],
      ['EBITA (operating profit)', money(f.ebit), ...fc.map((y) => money(y.ebit))],
      ['EBITA margin', pct(f.revenue ? f.ebit / f.revenue : NaN), ...fc.map((y) => pct(y.ebitMargin))],
      ['Operating cash taxes', money(-f.ebit * a.taxRate), ...fc.map((y) => money(-(y.ebit - y.nopat)))],
      [bold('NOPAT'), { v: f.ebit * (1 - a.taxRate), s: 'total' }, ...fc.map((y) => ({ v: y.nopat, s: 'total' as const }))],
      [],
      ['Operating tax rate applied', pct(a.taxRate)],
      ['Effective tax rate as reported', pct(f.effectiveTaxRate)],
      [note('Koller Ch. 18: NOPAT is taxed at the operating rate — the reported provision adjusted for the tax shield on interest and the tax on interest income — not at the effective rate.')],
    ],
  };
}

function investedCapitalSheet(p: ValuationPayload): Sheet {
  const { financials: f, result: r, reorganization: reorg } = p;
  const rows: Cell[][] = [
    ...sheetHeader(p, 'Invested capital and total funds invested', 'Koller Ch. 9 · adjustments per Ch. 19-22'),
    [{ v: 'Operating invested capital', s: 'header' }, { v: 'Amount', s: 'header' }, { v: 'Note', s: 'header' }],
  ];

  for (const item of reorg.investedCapitalBuild) rows.push([item.label, money(item.value), item.note ?? '']);
  rows.push([bold('Invested capital'), { v: f.investedCapital, s: 'total' }, '']);
  rows.push([]);

  rows.push([{ v: 'Nonoperating assets', s: 'header' }, { v: 'Amount', s: 'header' }, { v: 'Note', s: 'header' }]);
  if (reorg.nonoperatingAssetsBuild.length === 0) rows.push([note('None identified in the source data.')]);
  for (const item of reorg.nonoperatingAssetsBuild) rows.push([item.label, money(item.value), item.note ?? '']);
  rows.push([bold('Nonoperating assets'), { v: f.nonoperatingAssets, s: 'total' }, '']);
  rows.push([]);

  rows.push([{ v: 'Debt equivalents', s: 'header' }, { v: 'Amount', s: 'header' }, { v: 'Note', s: 'header' }]);
  if (reorg.debtEquivalentsBuild.length === 0) rows.push([note('None identified in the source data.')]);
  for (const item of reorg.debtEquivalentsBuild) rows.push([item.label, money(item.value), item.note ?? '']);
  rows.push([bold('Debt equivalents'), { v: f.debtEquivalents, s: 'total' }, '']);
  rows.push([]);

  const totalFunds = f.investedCapital + f.excessCash + f.nonoperatingAssets;
  rows.push([section('Total funds invested'), section(''), section('')]);
  rows.push(['Invested capital', money(f.investedCapital), '']);
  rows.push(['Excess cash and marketable securities', money(f.excessCash), 'Operating cash held separately']);
  rows.push(['Nonoperating assets', money(f.nonoperatingAssets), '']);
  rows.push([bold('Total funds invested'), { v: totalFunds, s: 'total' }, '']);
  rows.push([]);
  rows.push(['Operating cash (inside invested capital)', money(f.operatingCash), '']);
  rows.push(['Total debt', money(f.totalDebt), '']);
  rows.push(['Minority interest', money(f.minorityInterest), '']);
  rows.push([
    note('The financing side of the funds-invested identity (debt + debt equivalents + minority + book equity) is not reconstructed here because book equity is not among the fetched fields.'),
  ]);
  rows.push([]);

  rows.push([{ v: 'Invested capital roll-forward', s: 'header' }, { v: 'Opening invested capital', s: 'header' }, { v: 'Net investment', s: 'header' }]);
  for (const y of r.forecast) rows.push([`Y${y.year}`, money(y.investedCapital), money(y.netInvestment)]);

  rows.push([]);
  rows.push([{ v: 'Accounting adjustment', s: 'header' }, { v: 'Chapter', s: 'header' }, { v: 'Status', s: 'header' }, { v: 'Detail', s: 'header' }]);
  for (const adj of reorg.adjustments) {
    rows.push([adj.label, adj.chapter, adj.applied ? 'Applied' : 'Skipped', adj.detail]);
    for (const e of adj.effects) {
      rows.push([
        note(`  ${e.field}`),
        e.from === null ? note('n/a') : money(e.from),
        e.to === null ? note('n/a') : money(e.to),
        note('from → to'),
      ]);
    }
  }

  return { name: 'Invested capital', cols: [42, 18, 18, 60], rows };
}

function freeCashFlowSheet(p: ValuationPayload): Sheet {
  const rows: Cell[][] = [...sheetHeader(p, 'Free cash flow', 'Koller Ch. 9')];
  const fc = p.result.forecast;
  const headerRow = rows.length + 1;
  rows.push(yearHeader(p, 'Free cash flow'));

  const nopatRow = headerRow + 1;
  const investRow = headerRow + 2;
  const fcfRow = headerRow + 3;

  rows.push(['NOPAT', { v: null }, ...fc.map((y) => money(y.nopat))]);
  rows.push(['Net investment', { v: null }, ...fc.map((y) => money(-y.netInvestment))]);
  rows.push([
    bold('Free cash flow'),
    { v: null },
    ...fc.map((y, i) => ({
      v: y.freeCashFlow,
      s: 'total' as const,
      f: `${col(i + 2)}${nopatRow}+${col(i + 2)}${investRow}`,
    })),
  ]);
  rows.push(['Reinvestment rate', { v: null }, ...fc.map((y) => pct(y.reinvestmentRate))]);
  rows.push([]);
  rows.push([
    note(`Koller Ch. 9: free cash flow is NOPAT less the net investment needed to sustain growth, before financing. Row ${fcfRow} is a live formula so the sheet recalculates if you flex NOPAT or investment.`),
  ]);
  rows.push([
    note('Base-year cash flow items (D&A, capex, change in working capital) are held in the Data quality sheet with their sources; the forecast derives net investment from the growth and RONIC assumptions rather than from projected capex line items.'),
  ]);

  return { name: 'Free cash flow', cols: YEAR_COLS(p), rows };
}

function roicSheet(p: ValuationPayload): Sheet {
  const { result: r } = p;
  const fc = r.forecast;
  return {
    name: 'ROIC & economic profit',
    cols: YEAR_COLS(p),
    rows: [
      ...sheetHeader(p, 'ROIC and economic profit', 'Koller Ch. 10'),
      yearHeader(p, 'Return on invested capital'),
      ['Opening invested capital', { v: null }, ...fc.map((y) => money(y.investedCapital))],
      ['NOPAT', { v: null }, ...fc.map((y) => money(y.nopat))],
      ['ROIC', { v: null }, ...fc.map((y) => pct(y.roic))],
      ['WACC', { v: null }, ...fc.map(() => pct(r.wacc))],
      ['ROIC less WACC', { v: null }, ...fc.map((y) => pct(y.roic - r.wacc))],
      [bold('Economic profit'), { v: null }, ...fc.map((y) => ({ v: y.economicProfit, s: 'total' as const }))],
      ['PV of economic profit', { v: null }, ...fc.map((y) => money(y.pvEconomicProfit))],
      [],
      ['Incremental ROIC on new capital', { v: null }, ...fc.map((y) => pct(y.incrementalRoic))],
      [note('Koller Ch. 10: economic profit = (ROIC − WACC) × invested capital. It converts the same forecast into the annual value created, which the DCF hides inside the cash flow.')],
    ],
  };
}

function waccSheet(p: ValuationPayload): Sheet {
  const { result: r, assumptions: a, financials: f } = p;
  const rows: Cell[][] = [...sheetHeader(p, 'Cost of capital', 'Koller Ch. 13')];
  const start = rows.length + 1;

  // Row numbers for the live formulas below.
  const rfRow = start + 1;
  const erpRow = start + 2;
  const betaRow = start + 3;
  const crpRow = start + 4;
  const keRow = start + 5;
  const kdRow = start + 7;
  const taxRow = start + 8;
  const kdAtRow = start + 9;
  const weRow = start + 11;
  const wdRow = start + 12;
  const waccRow = start + 13;

  rows.push([{ v: 'Cost of equity (CAPM)', s: 'header' }, { v: 'Input', s: 'header' }]);
  rows.push(['Risk-free rate', pct(a.riskFreeRate)]);
  rows.push(['Equity risk premium', pct(a.equityRiskPremium)]);
  rows.push(['Beta', { v: a.beta, s: 'money2' }]);
  rows.push(['Country risk premium', pct(a.countryRiskPremium)]);
  rows.push([bold('Cost of equity'), { v: r.costOfEquity, s: 'pct', f: `B${rfRow}+B${betaRow}*B${erpRow}+B${crpRow}` }]);
  rows.push([]);
  rows.push([{ v: 'Cost of debt', s: 'header' }, { v: 'Input', s: 'header' }]);
  rows.push(['Pre-tax cost of debt', pct(a.preTaxCostOfDebt)]);
  rows.push(['Operating tax rate', pct(a.taxRate)]);
  rows.push([bold('After-tax cost of debt'), { v: r.afterTaxCostOfDebt, s: 'pct', f: `B${kdRow}*(1-B${taxRow})` }]);
  rows.push([]);
  rows.push([{ v: 'Capital structure (market values)', s: 'header' }, { v: 'Weight', s: 'header' }]);
  rows.push(['Weight of equity', pct(r.weightOfEquity)]);
  rows.push(['Weight of debt', pct(r.weightOfDebt)]);
  rows.push([bold('WACC'), { v: r.wacc, s: 'pct', f: `B${weRow}*B${keRow}+B${wdRow}*B${kdAtRow}` }]);
  rows.push([]);
  rows.push(['Market capitalization', money(f.marketCap)]);
  rows.push(['Total debt', money(f.totalDebt)]);
  rows.push(['Debt equivalents', money(f.debtEquivalents)]);
  rows.push([]);
  rows.push([note(`Cost of debt basis: ${r.costOfDebtBasis || 'not stated'}`)]);
  rows.push([
    note('Koller Ch. 13: weights are market values, not book. The country risk premium is additive and applies to emerging-market cash flows (Part 5).'),
  ]);
  // waccRow is referenced by the DCF sheet note; keep the variable used.
  rows.push([note(`WACC is computed in cell B${waccRow} as a live formula.`)]);

  return { name: 'WACC', cols: [40, 16], rows };
}

function dcfSheet(p: ValuationPayload): Sheet {
  const { result: r, assumptions: a } = p;
  const fc = r.forecast;
  const rows: Cell[][] = [...sheetHeader(p, 'Discounted cash flow valuation', 'Koller Ch. 8 · continuing value per Ch. 12')];

  const headerRow = rows.length + 1;
  rows.push([
    { v: 'Discounted free cash flow', s: 'header' },
    { v: '', s: 'header' },
    ...fc.map((y) => ({ v: `Y${y.year}`, s: 'header' as const })),
  ]);

  const fcfRow = headerRow + 1;
  const dfRow = headerRow + 2;
  const pvRow = headerRow + 3;

  rows.push(['Free cash flow', { v: null }, ...fc.map((y) => money(y.freeCashFlow))]);
  rows.push(['Discount factor', { v: null }, ...fc.map((y) => ({ v: y.discountFactor, s: 'money2' as const }))]);
  rows.push([
    bold('Present value'),
    { v: null },
    ...fc.map((y, i) => ({
      v: y.presentValue,
      s: 'total' as const,
      f: `${col(i + 2)}${fcfRow}*${col(i + 2)}${dfRow}`,
    })),
  ]);

  const lastCol = col(fc.length + 1);
  rows.push([]);
  const pvExplicitRow = rows.length + 1;
  rows.push([
    bold('PV of explicit + fade free cash flow'),
    { v: r.pvExplicitFcf, s: 'money', f: `SUM(C${pvRow}:${lastCol}${pvRow})` },
  ]);
  rows.push(['Continuing value at end of forecast', money(r.continuingValue)]);
  const pvCvRow = rows.length + 1;
  rows.push(['PV of continuing value', money(r.pvContinuingValue)]);
  rows.push([
    bold('Enterprise value'),
    { v: r.enterpriseValue, s: 'total', f: `B${pvExplicitRow}+B${pvCvRow}` },
  ]);
  rows.push([]);
  rows.push([section('Continuing value diagnostics'), section('')]);
  rows.push(['Continuing value share of enterprise value', pct(r.continuingValueDiagnostics.cvShareOfEnterpriseValue)]);
  rows.push(['Implied continuing-value EV/EBIT', mult(r.continuingValueDiagnostics.impliedCvEbitMultiple)]);
  rows.push(['Terminal ROIC on new capital', pct(r.continuingValueDiagnostics.terminalRoic)]);
  rows.push(['Terminal growth', pct(r.continuingValueDiagnostics.terminalGrowth)]);
  rows.push(['Terminal reinvestment rate', pct(r.continuingValueDiagnostics.terminalReinvestmentRate)]);
  for (const w of r.continuingValueDiagnostics.warnings) rows.push([note(`Flag: ${w}`)]);
  rows.push([]);
  rows.push([
    note(
      `Key value driver formula (Ch. 12): CV = NOPAT(T+1) x (1 - g / RONIC) / (WACC - g), with g = ${(
        a.terminalGrowth * 100
      ).toFixed(1)}%, RONIC = ${(a.terminalIncrementalRoic * 100).toFixed(1)}% and WACC = ${(r.wacc * 100).toFixed(1)}%.`
    ),
  ]);
  rows.push([
    note(
      a.midYearConvention
        ? 'Cash flows are discounted on a mid-year convention, so the discount factors above sit half a year earlier than year-end factors.'
        : 'Cash flows are discounted at year end.'
    ),
  ]);

  return { name: 'DCF valuation', cols: YEAR_COLS(p), rows };
}

function economicProfitValuationSheet(p: ValuationPayload): Sheet {
  const ep = p.result.economicProfit;
  const rows: Cell[][] = [...sheetHeader(p, 'Economic-profit valuation', 'Koller Ch. 8 cross-check')];
  const start = rows.length + 1;
  const icRow = start;
  const pvEpRow = start + 1;
  const pvCvRow = start + 2;

  rows.push(['Opening invested capital', money(ep.openingInvestedCapital)]);
  rows.push(['PV of economic profit, explicit + fade', money(ep.pvEconomicProfit)]);
  rows.push(['PV of continuing economic profit', money(ep.pvContinuingEconomicProfit)]);
  rows.push([
    bold('Enterprise value, economic-profit method'),
    { v: ep.enterpriseValue, s: 'total', f: `B${icRow}+B${pvEpRow}+B${pvCvRow}` },
  ]);
  rows.push(['Enterprise value, DCF method', money(p.result.enterpriseValue)]);
  rows.push(['Reconciliation error', pct(ep.reconciliationError)]);
  rows.push([]);
  rows.push(['Continuing economic profit', money(ep.continuingEconomicProfit)]);
  rows.push(['Current ROIC', pct(ep.currentRoic)]);
  rows.push(['ROIC less WACC', pct(ep.roicSpread)]);
  rows.push([]);
  rows.push([
    note('Koller Ch. 8: invested capital plus the present value of future economic profit must equal the DCF enterprise value. The identity holds exactly under end-of-year discounting, so this leg uses end-of-year factors even when the DCF above is on a mid-year convention; a reconciliation error above roughly 0.5% means the model is internally inconsistent.'),
  ]);

  return { name: 'Economic profit value', cols: [46, 18], rows };
}

function bridgeSheet(p: ValuationPayload): Sheet {
  const { result: r, financials: f } = p;
  const rows: Cell[][] = [...sheetHeader(p, 'From enterprise value to value per share', 'Koller Ch. 14')];
  const firstRow = rows.length + 1;

  for (const row of r.bridge.rows.slice(0, -1)) rows.push([row.label, money(row.value), row.note ?? '']);
  const lastItemRow = rows.length;
  const equityRow = rows.length + 1;
  rows.push([bold('Equity value'), { v: r.bridge.equityValue, s: 'total', f: `SUM(B${firstRow}:B${lastItemRow})` }, '']);
  const sharesRow = rows.length + 1;
  rows.push(['Shares outstanding', { v: f.sharesOutstanding, s: 'money' }, '']);
  rows.push([
    bold('Fair value per share'),
    { v: r.bridge.fairValuePerShare, s: 'money2', f: `B${equityRow}/B${sharesRow}` },
    '',
  ]);
  rows.push(['Market price', money2(r.marketPrice), '']);
  rows.push(['Gap vs market', pct(r.valuationGapPct), '']);
  rows.push([]);
  rows.push([
    note('Koller Ch. 14: enterprise value becomes equity value only after debt and debt equivalents are deducted and excess cash and nonoperating assets are added back. Employee stock options and convertible securities are not deducted here — they are not in the fetched data — so the per-share value is optimistic for companies that use them heavily.'),
  ]);

  return { name: 'Equity bridge', cols: [46, 18, 40], rows };
}

function analysisSheet(p: ValuationPayload): Sheet {
  const { result: r } = p;
  const s = r.sensitivity;
  const rows: Cell[][] = [...sheetHeader(p, 'Analysis of results', 'Koller Ch. 15 and 16 · scenarios per Part 5')];

  rows.push([section('Sensitivity: fair value per share'), section('')]);
  rows.push([
    { v: 'WACC down / growth across', s: 'header' },
    ...s.growthValues.map((g) => ({ v: g, s: 'pct' as const })),
  ]);
  s.waccValues.forEach((w, i) => {
    rows.push([{ v: w, s: 'pct' }, ...s.growthValues.map((_, j) => money2(s.fairValues[i][j]))]);
  });
  rows.push([note(`Base case: WACC ${(s.baseWacc * 100).toFixed(1)}%, long-run growth ${(s.baseGrowth * 100).toFixed(1)}%. Blank or n/a cells are combinations where growth is too close to the WACC for the perpetuity formula to mean anything.`)]);
  rows.push([]);

  rows.push([section('Implied multiples'), section('')]);
  rows.push(['DCF implied EV/EBIT', mult(r.impliedMultiples.dcfEvToEbit)]);
  rows.push(['Market EV/EBIT', mult(r.impliedMultiples.marketEvToEbit)]);
  rows.push(['DCF implied EV/revenue', mult(r.impliedMultiples.dcfEvToRevenue)]);
  rows.push(['DCF implied P/E on NOPAT', mult(r.impliedMultiples.dcfImpliedPe)]);
  rows.push(['Market P/E on NOPAT', mult(r.impliedMultiples.marketPe)]);
  rows.push([note('Koller Ch. 16: multiples are a cross-check on the DCF, not a substitute. Both columns use the same NOPAT basis so they are comparable.')]);
  rows.push([]);

  if (r.scenarios) {
    rows.push([section('Probability-weighted scenarios'), section(''), section(''), section(''), section('')]);
    rows.push([
      { v: 'Scenario', s: 'header' },
      { v: 'Probability', s: 'header' },
      { v: 'Stage 1 growth', s: 'header' },
      { v: 'Stage 1 RONIC', s: 'header' },
      { v: 'Fair value per share', s: 'header' },
    ]);
    for (const sc of r.scenarios.scenarios) {
      rows.push([
        sc.name,
        pct(sc.probability),
        pct(sc.stage1RevenueGrowth),
        pct(sc.stage1IncrementalRoic),
        money2(sc.fairValuePerShare),
      ]);
    }
    rows.push([bold('Probability-weighted fair value per share'), '', '', '', { v: r.scenarios.weightedFairValuePerShare, s: 'total' }]);
    rows.push([note(r.scenarios.rationale)]);
  } else {
    rows.push([note('Scenario analysis is generated only for high-growth companies (Koller Part 5), where a single forecast is a poor description of the outcome distribution.')]);
  }

  return { name: 'Analysis of results', cols: [32, 16, 16, 16, 20], rows };
}

function assumptionsSheet(p: ValuationPayload): Sheet {
  const { assumptions: a, dataQuality } = p;
  const rows: Cell[][] = [...sheetHeader(p, 'Assumptions and data quality', 'Inputs behind every number in this workbook')];

  rows.push([section('Assumptions'), section('')]);
  const entries: [string, Cell][] = [
    ['Risk-free rate', pct(a.riskFreeRate)],
    ['Equity risk premium', pct(a.equityRiskPremium)],
    ['Country risk premium', pct(a.countryRiskPremium)],
    ['Beta', { v: a.beta, s: 'money2' }],
    ['Pre-tax cost of debt', pct(a.preTaxCostOfDebt)],
    ['Operating tax rate', pct(a.taxRate)],
    ['Explicit forecast years', a.explicitYears],
    ['Fade years', a.fadeYears],
    ['Stage 1 revenue growth', pct(a.stage1RevenueGrowth)],
    ['Long-run growth', pct(a.terminalGrowth)],
    ['Stage 1 return on new invested capital', pct(a.stage1IncrementalRoic)],
    ['Terminal return on new invested capital', pct(a.terminalIncrementalRoic)],
    ['Target EBIT margin', a.ebitMarginTarget === null ? 'held flat' : pct(a.ebitMarginTarget)],
    ['Mid-year discounting', a.midYearConvention ? 'yes' : 'no'],
  ];
  for (const [label, value] of entries) rows.push([label, value]);
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
  rows.push([
    note('Anything marked Estimated or Assumption was not read from a filing. Those are the inputs to challenge first.'),
  ]);

  return { name: 'Assumptions & sources', cols: [40, 26, 60, 16], rows };
}

// ---------------------------------------------------------------------------

/** Zero-based column index to spreadsheet letter, local copy to avoid a cycle. */
function col(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function buildValuationWorkbook(p: ValuationPayload): Sheet[] {
  return [
    summarySheet(p),
    nopatSheet(p),
    investedCapitalSheet(p),
    freeCashFlowSheet(p),
    roicSheet(p),
    waccSheet(p),
    dcfSheet(p),
    economicProfitValuationSheet(p),
    bridgeSheet(p),
    analysisSheet(p),
    assumptionsSheet(p),
  ];
}

export function workbookFileName(f: Financials): string {
  const safeTicker = f.ticker.replace(/[^A-Za-z0-9.-]/g, '_');
  return `${safeTicker}_DCF_valuation.xlsx`;
}
