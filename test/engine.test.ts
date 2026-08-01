// Offline checks on the DCF engine. No network, no filings: synthetic inputs
// chosen so every identity can be verified by hand.
import assert from 'node:assert/strict';
import { buildForecast, calculateWacc, defaultAssumptions, runDcf } from '../lib/dcf';
import { capitalizeRnd, detectFinancial, normalizeCycle, operatingTaxRate, reorganize } from '../lib/adjustments';
import { factsFromEdgar } from '../lib/statements';
import { estimateBeta, MARKET_UNLEVERED_BETA, relever, smoothRawBeta, unlever } from '../lib/beta';
import { equityDcf, EquityDcfInputs } from '../lib/equityDcf';
import { buildEquityWorkbook } from '../lib/equityWorkbook';
import { Cell } from '../lib/xlsx';
import { CompanyFacts, XbrlFact, edgarStatementFacts, extractFinancials, screenRecommendationHistory } from '../lib/secEdgar';
import { Financials } from '../lib/types';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log('  pass  ' + name);
  } catch (e: any) {
    failures += 1;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// A profitable, moderately levered industrial. ROIC = 150*0.75/1000 = 11.25%.
function base(): Financials {
  return {
    ticker: 'TEST',
    companyName: 'Test Industrials',
    fiscalYearEnd: '2025-12-31',
    currency: 'USD',
    marketName: 'United States',
    revenue: 1000,
    ebit: 150,
    effectiveTaxRate: 0.25,
    depreciationAmortization: 60,
    capex: 70,
    changeInNWC: 10,
    investedCapital: 1000,
    totalDebt: 300,
    cashAndEquivalents: 120,
    minorityInterest: 20,
    operatingCash: 20,
    excessCash: 100,
    nonoperatingAssets: 50,
    debtEquivalents: 40,
    revenueCagr3y: 0.06,
    sharePrice: 25,
    sharesOutstanding: 100,
    marketCap: 2500,
    beta: 1.1,
    isFinancial: false,
    estimatedFields: [],
  };
}

console.log('cost of capital');
check('WACC weights sum to one and sit between the two component costs', () => {
  const f = base();
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const w = calculateWacc(f, a);
  assert.ok(close(w.weightOfEquity + w.weightOfDebt, 1));
  assert.ok(w.wacc < w.costOfEquity, 'WACC should be below cost of equity when debt is cheaper');
  assert.ok(w.wacc > w.afterTaxCostOfDebt, 'WACC should be above the after-tax cost of debt');
  // Debt weight uses market debt including debt equivalents (Ch. 19/20).
  assert.ok(close(w.weightOfDebt, 340 / (2500 + 340)));
});

check('country risk premium lifts the cost of equity additively', () => {
  const f = base();
  const a1 = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const a2 = defaultAssumptions(f, { riskFreeRate: 0.042, countryRiskPremium: 0.015 });
  const w1 = calculateWacc(f, a1);
  const w2 = calculateWacc(f, a2);
  assert.ok(close(w2.costOfEquity - w1.costOfEquity, 0.015));
});

console.log('forecast mechanics');
check('reinvestment rate equals growth over incremental ROIC and FCF follows', () => {
  const f = base();
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const w = calculateWacc(f, a).wacc;
  const fc = buildForecast(f, a, w);
  assert.ok(fc.length === a.explicitYears + a.fadeYears);
  for (const y of fc) {
    assert.ok(close(y.reinvestmentRate, y.growth / y.incrementalRoic, 1e-9), 'RR = g / RONIC at year ' + y.year);
    assert.ok(close(y.freeCashFlow, y.nopat * (1 - y.reinvestmentRate), 1e-9), 'FCF = NOPAT x (1 - RR)');
    assert.ok(close(y.netInvestment, y.nopat - y.freeCashFlow, 1e-9), 'net investment = NOPAT - FCF');
  }
});

check('invested capital rolls forward by net investment and ROIC follows from it', () => {
  const f = base();
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const w = calculateWacc(f, a).wacc;
  const fc = buildForecast(f, a, w);
  assert.ok(close(fc[0].investedCapital, f.investedCapital), 'year 1 opens at reported invested capital');
  for (let i = 1; i < fc.length; i += 1) {
    const expected = fc[i - 1].investedCapital + fc[i - 1].netInvestment;
    assert.ok(close(fc[i].investedCapital, expected, 1e-9), 'roll-forward at year ' + fc[i].year);
  }
  for (const y of fc) {
    assert.ok(close(y.roic, y.nopat / y.investedCapital, 1e-9));
    assert.ok(close(y.economicProfit, (y.roic - w) * y.investedCapital, 1e-9), 'EP = (ROIC - WACC) x IC');
  }
});

check('growth fades monotonically from stage 1 to terminal', () => {
  const f = base();
  const a = { ...defaultAssumptions(f, { riskFreeRate: 0.042 }), stage1RevenueGrowth: 0.1, terminalGrowth: 0.025 };
  const w = calculateWacc(f, a).wacc;
  const fc = buildForecast(f, a, w);
  for (let i = 1; i < fc.length; i += 1) {
    assert.ok(fc[i].growth <= fc[i - 1].growth + 1e-12, 'growth should never rise at year ' + fc[i].year);
  }
  assert.ok(close(fc[fc.length - 1].growth, a.terminalGrowth, 1e-6), 'last fade year lands on terminal growth');
});

console.log('value identities');
check('economic profit reconciles to the DCF enterprise value', () => {
  const f = base();
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const r = runDcf(f, a);
  assert.ok(
    Math.abs(r.economicProfit.reconciliationError) < 1e-9,
    'reconciliation error was ' + r.economicProfit.reconciliationError
  );
});

check('economic profit reconciles for a value destroyer too', () => {
  const f = { ...base(), ebit: 60 }; // ROIC 4.5%, below any plausible WACC
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const r = runDcf(f, a);
  assert.ok(r.economicProfit.roicSpread < 0, 'this case should show a negative spread');
  assert.ok(Math.abs(r.economicProfit.reconciliationError) < 1e-9);
});

check('bridge rows sum to the equity value and to the per-share figure', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  const rows = r.bridge.rows;
  const withoutTotal = rows.slice(0, rows.length - 1).reduce((s, x) => s + x.value, 0);
  assert.ok(close(withoutTotal, r.bridge.equityValue), 'signed rows must add to equity value');
  assert.ok(close(rows[rows.length - 1].value, r.bridge.equityValue), 'last row is the equity value total');
  assert.ok(close(r.bridge.fairValuePerShare, r.bridge.equityValue / f.sharesOutstanding));
  assert.ok(close(r.fairValuePerShare, r.bridge.fairValuePerShare), 'headline matches the bridge');
});

check('excess cash and nonoperating assets are each counted exactly once', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  const plusRows = r.bridge.rows.filter((x) => x.value === f.excessCash || x.value === f.nonoperatingAssets);
  assert.ok(plusRows.length === 2, 'expected one excess-cash row and one nonoperating-asset row');
  // net debt on the headline uses the same definition as the bridge
  assert.ok(close(r.netDebt, f.totalDebt + f.debtEquivalents - f.excessCash - f.nonoperatingAssets));
});

check('enterprise value equals PV of explicit FCF plus PV of continuing value', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  assert.ok(close(r.enterpriseValue, r.pvExplicitFcf + r.pvContinuingValue));
  assert.ok(close(r.pvExplicitFcf, r.forecast.reduce((s, y) => s + y.presentValue, 0)));
});

check('verdict and gap agree with the prices', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  assert.ok(close(r.valuationGapPct, (r.fairValuePerShare - r.marketPrice) / r.marketPrice));
  const expected =
    Math.abs(r.valuationGapPct) <= 0.075 ? 'fairly valued' : r.valuationGapPct > 0 ? 'undervalued' : 'overvalued';
  assert.equal(r.verdict, expected);
});

console.log('diagnostics');
check('sensitivity grid is monotonic in WACC and blanks the degenerate corner', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  const s = r.sensitivity;
  assert.ok(s.waccValues.length === 5 && s.growthValues.length === 5);
  for (let j = 0; j < s.growthValues.length; j += 1) {
    for (let i = 1; i < s.waccValues.length; i += 1) {
      const lo = s.fairValues[i - 1][j];
      const hi = s.fairValues[i][j];
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        assert.ok(hi <= lo + 1e-9, 'a higher WACC must not raise value (col ' + j + ')');
      }
    }
  }
  for (let i = 0; i < s.waccValues.length; i += 1) {
    for (let j = 0; j < s.growthValues.length; j += 1) {
      const degenerate = s.waccValues[i] - s.growthValues[j] < 0.005;
      if (degenerate) assert.ok(Number.isNaN(s.fairValues[i][j]), 'w - g under 50bp should be blank');
    }
  }
});

check('the base cell of the grid reproduces the headline fair value', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  const s = r.sensitivity;
  const i = s.waccValues.findIndex((w) => Math.abs(w - s.baseWacc) < 1e-9);
  const j = s.growthValues.findIndex((g) => Math.abs(g - s.baseGrowth) < 1e-9);
  assert.ok(i >= 0 && j >= 0, 'base row/column should be present in the grid');
  assert.ok(close(s.fairValues[i][j], r.fairValuePerShare, 1e-6));
});

check('continuing-value share is a fraction and flags a stretched terminal', () => {
  const f = base();
  const a = defaultAssumptions(f, { riskFreeRate: 0.042 });
  const r = runDcf(f, a);
  const d = r.continuingValueDiagnostics;
  assert.ok(d.cvShareOfEnterpriseValue > 0 && d.cvShareOfEnterpriseValue < 1);
  assert.ok(close(d.cvShareOfEnterpriseValue, r.pvContinuingValue / r.enterpriseValue));
  assert.ok(close(d.terminalReinvestmentRate, d.terminalGrowth / d.terminalRoic, 1e-9));
  const stretched = runDcf(f, { ...a, terminalGrowth: 0.055 });
  assert.ok(stretched.continuingValueDiagnostics.warnings.length > 0, 'a 5.5% perpetuity should raise a flag');
});

check('implied multiples are positive and the market pair uses the same bridge', () => {
  const f = base();
  const r = runDcf(f, defaultAssumptions(f, { riskFreeRate: 0.042 }));
  const im = r.impliedMultiples;
  assert.ok(close(im.dcfEvToEbit, r.enterpriseValue / f.ebit));
  assert.ok(close(im.dcfEvToRevenue, r.enterpriseValue / f.revenue));
  const marketEv = f.marketCap + f.totalDebt + f.debtEquivalents - f.excessCash - f.nonoperatingAssets + f.minorityInterest;
  assert.ok(close(im.marketEvToEbit, marketEv / f.ebit));
  assert.ok(im.marketPe > 0 && im.dcfImpliedPe > 0);
});

console.log('scenarios');
check('scenarios stay null for a steady grower and appear for a fast one', () => {
  const f = base();
  const slow = runDcf(f, { ...defaultAssumptions(f, { riskFreeRate: 0.042 }), stage1RevenueGrowth: 0.06 });
  assert.equal(slow.scenarios, null, 'a 6% grower needs no scenario tree');
  const fast = runDcf(f, { ...defaultAssumptions(f, { riskFreeRate: 0.042 }), stage1RevenueGrowth: 0.22 });
  assert.ok(fast.scenarios !== null, 'a 22% grower should get scenarios');
});

check('scenario probabilities sum to one and the weighted value is the weighted mean', () => {
  const f = base();
  const r = runDcf(f, { ...defaultAssumptions(f, { riskFreeRate: 0.042 }), stage1RevenueGrowth: 0.22 });
  const s = r.scenarios;
  assert.ok(s !== null);
  if (s === null) return;
  assert.ok(close(s.scenarios.reduce((t, x) => t + x.probability, 0), 1));
  const mean = s.scenarios.reduce((t, x) => t + x.probability * x.fairValuePerShare, 0);
  assert.ok(close(s.weightedFairValuePerShare, mean, 1e-9));
  const values = s.scenarios.map((x) => x.fairValuePerShare);
  assert.ok(Math.max(...values) > Math.min(...values), 'the upside and downside cases must differ');
});

console.log('accounting adjustments');
check('R&D capitalizes over three years with straight-line amortization', () => {
  // 30 spent this year, 30 the year before, 30 the year before that.
  const cap = capitalizeRnd([30, 30, 30], 3);
  assert.ok(cap !== null);
  if (cap === null) return;
  // asset = 30 x 3/3 + 30 x 2/3 + 30 x 1/3 = 60; amortization = 90/3 = 30
  assert.ok(close(cap.asset, 60, 1e-9));
  assert.ok(close(cap.amortization, 30, 1e-9));
  assert.ok(close(cap.currentSpend, 30));
  assert.equal(capitalizeRnd([], 3), null);
});

check('operating tax rate strips the interest tax shield and rejects nonsense', () => {
  const f = factsFromEdgar({});
  f.incomeTaxExpense = 30;
  f.interestExpense = 20;
  f.interestIncome = 4;
  // (30 + 0.25 x 20 - 0.25 x 4) / 150 = (30 + 5 - 1) / 150 = 34 / 150
  const ok = operatingTaxRate(f, 150, 0.25);
  assert.ok(ok.rate !== null);
  assert.ok(close(ok.rate as number, 34 / 150, 1e-9));
  const silly = factsFromEdgar({});
  silly.incomeTaxExpense = 400; // 400 / 150 is far outside any believable band
  assert.equal(operatingTaxRate(silly, 150, 0.25).rate, null);
  assert.equal(operatingTaxRate(f, null, 0.25).rate, null);
});

check('cycle normalization triggers on a swinging margin, not a steady one', () => {
  const steady = factsFromEdgar({});
  steady.revenue = 1000;
  steady.revenueHistory = [1000, 980, 960, 940, 920];
  steady.ebitHistory = [150, 147, 144, 141, 138];
  assert.equal(normalizeCycle(steady).cyclical, false, 'a flat 15% margin is not cyclical');

  const swinging = factsFromEdgar({});
  swinging.revenue = 1000;
  swinging.revenueHistory = [1000, 900, 1100, 950, 1050];
  swinging.ebitHistory = [250, 45, 210, 30, 190]; // margins 25%, 5%, 19%, 3%, 18%
  const n = normalizeCycle(swinging);
  assert.equal(n.cyclical, true, 'margins from 3% to 25% should read as cyclical');
  assert.ok(n.normalizedEbit !== null);
  assert.ok((n.normalizedEbit as number) < 250, 'peak-year EBIT should be pulled down toward the median margin');
});

check('banks are detected by name, by interest mix, and by an asset-light balance sheet', () => {
  const plain = factsFromEdgar({});
  assert.equal(detectFinancial('Test Industrials', plain).isFinancial, false);
  assert.equal(detectFinancial('Sumitomo Mitsui Banking Corp', plain).isFinancial, true);
  assert.equal(detectFinancial('招商银行', plain).isFinancial, true);
  assert.equal(detectFinancial('Allstate Insurance', plain).isFinancial, true);

  const byMix = factsFromEdgar({});
  byMix.revenue = 100;
  byMix.interestIncome = 80;
  assert.equal(detectFinancial('Opaque Holdings', byMix).isFinancial, true);

  const byBalanceSheet = factsFromEdgar({});
  byBalanceSheet.totalAssets = 1000;
  byBalanceSheet.netPPE = 10; // 1% of assets
  byBalanceSheet.totalDebt = 700; // 70% of assets
  assert.equal(detectFinancial('Opaque Holdings', byBalanceSheet).isFinancial, true);

  // JPMorgan's real 2025 figures. The debt-share test above cannot see this
  // bank at all: $2.4tn of customer deposits sits outside the debt tag, so
  // tagged debt is 6.9% of assets. What no bank can hide is the other side of
  // the identity — equity at 7.4% of assets.
  const jpm = factsFromEdgar({});
  jpm.totalAssets = 4900475e6;
  jpm.netPPE = 29677e6;
  jpm.totalDebt = 337977e6;
  jpm.totalEquity = 364038e6;
  jpm.revenue = 182447e6;
  jpm.interestIncome = 28032e6;
  assert.ok((jpm.totalDebt as number) / (jpm.totalAssets as number) < 0.5, 'the debt-share test really does miss it');
  assert.equal(detectFinancial('JPMORGAN CHASE & CO', jpm).isFinancial, true);

  // A leveraged buyout of an asset-light company must not be read as a bank.
  // What separates the two is that its balance sheet is purchase premium
  // rather than loans and securities.
  const lbo = factsFromEdgar({});
  lbo.totalAssets = 1000;
  lbo.netPPE = 20;
  lbo.totalEquity = 100; // 10% of assets, bank-like leverage
  lbo.goodwill = 600;
  assert.equal(detectFinancial('Acquisitive Software Holdings', lbo).isFinancial, false);
});

check('reorganize splits cash, builds invested capital, and logs what it skipped', () => {
  const f = factsFromEdgar({});
  f.revenue = 1000;
  f.ebit = 150;
  f.cash = 120;
  f.shortTermInvestments = 30;
  f.netPPE = 600;
  f.workingCapital = 200;
  f.goodwill = 150;
  f.totalDebt = 300;
  f.incomeTaxExpense = 30;
  f.interestExpense = 20;

  const r = reorganize('Test Industrials', f, { marginalTaxRate: 0.25 });
  assert.ok(close(r.operatingCash, 20), 'operating cash is 2% of revenue');
  assert.ok(close(r.excessCash, 130), 'excess cash is 100 of cash plus 30 of short-term investments');
  // IC = 600 PPE + (200 working capital - 130 excess cash) + 150 goodwill = 820
  assert.ok(r.investedCapital !== null);
  assert.ok(close(r.investedCapital as number, 820, 1e-9));
  assert.ok(close(r.investedCapital as number, r.reorganization.investedCapitalBuild.reduce((s, x) => s + x.value, 0), 1e-9));
  assert.equal(r.isFinancial, false);
  assert.ok(r.reorganization.adjustments.length > 0, 'the log should record every attempted adjustment');
  const leases = r.reorganization.adjustments.find((x) => x.chapter.indexOf('20') >= 0);
  assert.ok(leases !== undefined && leases.applied === false, 'no lease disclosure here, so it must be logged as skipped');
});

check('a disclosed operating lease becomes both an asset and a debt equivalent', () => {
  const f = factsFromEdgar({});
  f.revenue = 1000;
  f.ebit = 150;
  f.netPPE = 600;
  f.workingCapital = 100;
  f.operatingLeaseLiabilities = 80;
  f.operatingLeaseAssets = 75;
  const r = reorganize('Test Industrials', f, { marginalTaxRate: 0.25 });
  assert.ok(close(r.debtEquivalents, 80), 'the liability is a debt equivalent');
  assert.ok(close(r.investedCapital as number, 600 + 100 + 75, 1e-9), 'the ROU asset joins invested capital');
  const leases = r.reorganization.adjustments.find((x) => x.chapter.indexOf('20') >= 0);
  assert.ok(leases !== undefined && leases.applied === true);
});

check('unlevering and relevering a beta round-trips (Ch. 15)', () => {
  const de = 0.4;
  assert.ok(close(relever(unlever(1.2, de), de), 1.2));
  // Market anchor: levered market beta is 1.0 by construction.
  assert.ok(close(relever(MARKET_UNLEVERED_BETA, 1 / 3), 1.0));
});

check('Blume smoothing pulls a raw regression beta toward 1.0', () => {
  assert.ok(close(smoothRawBeta(1.0), 1.0), 'a beta of 1.0 is a fixed point');
  assert.ok(smoothRawBeta(1.6) < 1.6 && smoothRawBeta(1.6) > 1.0);
  assert.ok(smoothRawBeta(0.5) > 0.5 && smoothRawBeta(0.5) < 1.0);
});

check('estimateBeta relevers the market anchor when no regression beta exists', () => {
  // Debt-free firm: beta collapses to the unlevered market beta.
  const unlevered = estimateBeta({ marketCap: 1000, debtIncludingEquivalents: 0 });
  assert.ok(close(unlevered.beta, MARKET_UNLEVERED_BETA));
  assert.equal(unlevered.confidence, 'estimated');

  // Levered firm: more debt, higher equity beta, same unlevered beta.
  const levered = estimateBeta({ marketCap: 1000, debtIncludingEquivalents: 500 });
  assert.ok(close(levered.beta, MARKET_UNLEVERED_BETA * 1.5));
  assert.ok(levered.beta > unlevered.beta, 'leverage must raise the equity beta');
  assert.ok(close(levered.unleveredBeta, unlevered.unleveredBeta));

  // Extreme leverage is capped rather than allowed to run away.
  const wild = estimateBeta({ marketCap: 10, debtIncludingEquivalents: 10000 });
  assert.equal(wild.clamped, true);
  assert.ok(wild.beta <= 2.5);

  // No market cap: fall back to the market's own capital structure, beta 1.0.
  const noCap = estimateBeta({ marketCap: null, debtIncludingEquivalents: 500 });
  assert.ok(close(noCap.beta, 1.0));
});

check('estimateBeta prefers a supplied regression beta and smooths it', () => {
  const e = estimateBeta({ rawRegressionBeta: 1.5, marketCap: 1000, debtIncludingEquivalents: 500 });
  assert.ok(close(e.beta, smoothRawBeta(1.5)));
  assert.equal(e.confidence, 'derived');
  assert.ok(close(e.unleveredBeta, e.beta / 1.5), 'unlevered at D/E of 0.5');
});

check('a bank is never relevered, because its leverage is operating (Part 5)', () => {
  // A bank funded eight to one. Relevering the market anchor here would give
  // 0.75 x 9 = 6.75, clamped to the 2.5 ceiling, and a cost of equity near 18%
  // -- the single rate the whole equity model hangs on.
  const opts = { marketCap: 1000, debtIncludingEquivalents: 8000 };
  const industrial = estimateBeta(opts);
  assert.ok(industrial.clamped && close(industrial.beta, 2.5), 'the industrial route does clamp at the ceiling');

  const bank = estimateBeta({ ...opts, isFinancial: true });
  assert.ok(close(bank.beta, 1.0), 'the market beta is used directly');
  assert.ok(!bank.clamped);
  assert.ok(bank.basis.indexOf('Part 5') >= 0, 'the reason has to be disclosed, not silent');

  // A published regression beta is still an improvement, still not relevered.
  const withRegression = estimateBeta({ ...opts, isFinancial: true, rawRegressionBeta: 1.2 });
  assert.ok(close(withRegression.beta, smoothRawBeta(1.2)));
  assert.ok(close(withRegression.unleveredBeta, withRegression.beta), 'no unlevering for a bank');
});

check('cash resolves from the latest balance sheet and reports which one', () => {
  // EDGAR path is exercised live; here the shape contract is what matters:
  // a fact set with no cash must leave cashSource null rather than pretend.
  const empty = factsFromEdgar({});
  assert.equal(empty.cash, null);
  assert.equal(empty.cashSource, null);

  const withCash = factsFromEdgar({
    cash: 500,
    cashSource: { field: 'CashAndCashEquivalentsAtCarryingValue', period: '2026-03-31', interim: true },
  });
  assert.equal(withCash.cash, 500);
  assert.equal(withCash.cashSource?.interim, true);
});

check('excess cash falls back to the overview figure when the balance sheet has none', () => {
  const f = factsFromEdgar({});
  f.revenue = 1000;
  f.ebit = 150;
  f.netPPE = 600;
  f.workingCapital = 200;
  const r = reorganize('Test Industrials', f, { marginalTaxRate: 0.25, cashFallback: 300 });
  assert.ok(close(r.operatingCash, 20), 'operating cash is still 2% of revenue');
  assert.ok(close(r.excessCash, 280), 'the fallback cash balance must reach the bridge');
  const split = r.reorganization.adjustments.find((x) => x.label.indexOf('excess cash') >= 0);
  assert.ok(
    split !== undefined && split.detail.indexOf('overview cash balance') >= 0,
    'using the fallback must be disclosed'
  );
});

console.log('equity cash flow model (Part 5)');

// A bank earning exactly its cost of equity, growing at 3%. Every identity
// below can be checked by hand against this one set of inputs.
function bank(over: Partial<EquityDcfInputs> = {}): EquityDcfInputs {
  return {
    netIncome: 100,
    bookEquity: 1000,
    costOfEquity: 0.1,
    growth: 0.03,
    terminalGrowth: 0.03,
    explicitYears: 10,
    sharesOutstanding: 100,
    sharePrice: 10,
    ...over,
  };
}

check('ROE equal to the cost of equity returns book equity exactly', () => {
  // The competitive-equilibrium identity, and the strongest audit the model
  // has: no excess return means no value above the capital already invested.
  const r = equityDcf(bank());
  assert.ok(close(r.equityValue, 1000, 1e-9), `expected 1000, got ${r.equityValue}`);
  assert.ok(close(r.impliedPriceToBook, 1, 1e-9));
  assert.ok(close(r.fairValuePerShare, 10, 1e-9));
});

check('ROE above the cost of equity puts value above book, and below puts it under', () => {
  const rich = equityDcf(bank({ netIncome: 150 }));
  const poor = equityDcf(bank({ netIncome: 60 }));
  assert.ok(rich.equityValue > 1000, 'a 15% ROE must be worth more than book');
  assert.ok(poor.equityValue < 1000, 'a 6% ROE must be worth less than book');
  assert.ok(rich.impliedPriceToBook > 1 && poor.impliedPriceToBook < 1);
});

check('equity cash flow is net income less the growth in the capital base', () => {
  const r = equityDcf(bank());
  const y1 = r.forecast[0];
  assert.ok(close(y1.openingEquity, 1000));
  assert.ok(close(y1.netIncome, 100));
  assert.ok(close(y1.equityInvestment, 30), '3% of 1000');
  assert.ok(close(y1.equityCashFlow, 70), '100 - 30');
  assert.ok(close(r.forecast[1].openingEquity, 1030), 'equity rolls forward by the retained amount');
  assert.ok(close(y1.discountFactor, 1 / 1.1), 'end-of-year discounting, not mid-year');
});

check('terminal ROE defaults to the current ROE, and the equilibrium case stays reachable', () => {
  // The bank fixture earns exactly its cost of equity, so the two assumptions
  // coincide there and prove nothing. A franchise bank separates them.
  const franchise = equityDcf(bank({ netIncome: 150 }));
  assert.ok(close(franchise.terminalReturnOnEquity, 0.15), 'the current 15% return carries into perpetuity');

  const equilibrium = equityDcf(bank({ netIncome: 150, terminalReturnOnEquity: 0.1 }));
  assert.ok(close(equilibrium.terminalReturnOnEquity, 0.1));
  assert.ok(
    franchise.equityValue > equilibrium.equityValue,
    'assuming the advantage persists must be worth more than assuming it fades'
  );

  // The reader has to be told which of the two was assumed, and what the other
  // one would have produced -- the whole verdict can turn on it.
  const w = franchise.warnings.find((s) => s.indexOf('durable competitive advantage') >= 0);
  assert.ok(w, 'the assumption must be disclosed, not silent');
  const perShare = equilibrium.equityValue / 100;
  assert.ok((w as string).indexOf(perShare.toFixed(2)) >= 0, 'the disclosure quotes the equilibrium value it computed');

  // A loss year gives a meaningless return, so the equilibrium assumption has
  // to take over rather than perpetuating a negative ROE.
  assert.ok(close(equityDcf(bank({ netIncome: -20 })).terminalReturnOnEquity, 0.1));
  // Likewise a return at or under the growth rate, which cannot fund growth.
  assert.ok(close(equityDcf(bank({ netIncome: 25, terminalGrowth: 0.03 })).terminalReturnOnEquity, 0.1));

  // The grid has to be a sensitivity around the answer, so its centre cell is
  // the headline value rather than a differently-assumed number.
  const mid = franchise.sensitivity.fairValues[2][2];
  assert.ok(close(mid, franchise.fairValuePerShare), `centre cell ${mid} should equal ${franchise.fairValuePerShare}`);
});

check('growth above ROE drives equity cash flow negative and is flagged', () => {
  const r = equityDcf(bank({ netIncome: 50, growth: 0.08 }));
  assert.ok(r.forecast[0].equityCashFlow < 0, 'the bank has to raise capital, not pay it out');
  assert.ok(
    r.warnings.some((w) => w.indexOf('exceeds the return on equity') >= 0),
    'the user must be told the growth rate is not self-funding'
  );
});

check('long-run growth is capped below the cost of equity', () => {
  const r = equityDcf(bank({ terminalGrowth: 0.2 }));
  assert.ok(r.terminalGrowth < 0.1, 'growth at or above Ke makes the perpetuity meaningless');
  assert.ok(Number.isFinite(r.equityValue));
  assert.ok(r.warnings.some((w) => w.indexOf('capped') >= 0));
});

check('non-positive book equity or net income is refused rather than valued', () => {
  const noEquity = equityDcf(bank({ bookEquity: -50 }));
  assert.ok(noEquity.warnings.some((w) => w.indexOf('Book equity is zero or negative') >= 0));
  const loss = equityDcf(bank({ netIncome: -20 }));
  assert.ok(loss.warnings.some((w) => w.indexOf('zero or negative') >= 0));
});

check('value falls monotonically as the cost of equity rises', () => {
  const r = equityDcf(bank({ netIncome: 150 }));
  const column = r.sensitivity.fairValues.map((row) => row[0]);
  for (let i = 1; i < column.length; i++) {
    assert.ok(column[i] < column[i - 1], `row ${i} should be cheaper than row ${i - 1}`);
  }
});

check('the continuing value carries the reinvestment the growth requires', () => {
  const r = equityDcf(bank({ netIncome: 150 }));
  const closingEquity = r.forecast[r.forecast.length - 1].openingEquity * (1 + r.growth);
  const niNext = closingEquity * r.terminalReturnOnEquity;
  const expected = (niNext * (1 - r.terminalGrowth / r.terminalReturnOnEquity)) / (r.costOfEquity - r.terminalGrowth);
  assert.ok(close(r.continuingValue, expected), 'CV = NI(t+1) x (1 - g/ROE) / (Ke - g)');
});

console.log('equity workbook (Part 5 export)');

function equityBook() {
  const f: Financials = { ...base(), isFinancial: true, sharesOutstanding: 100, sharePrice: 10 };
  const e = equityDcf(bank({ netIncome: 150 }));
  return buildEquityWorkbook({
    financials: f,
    assumptions: defaultAssumptions(f, { riskFreeRate: 0.042 }),
    equityValuation: e,
    dataQuality: [{ field: 'Net income', value: '150', basis: 'Income statement', confidence: 'source' }],
  });
}

check('the equity workbook has the six sheets, each with a legal name', () => {
  const names = equityBook().map((s) => s.name);
  assert.deepEqual(names, [
    'Summary',
    'Cost of equity',
    'Equity cash flow',
    'Equity valuation',
    'Analysis of results',
    'Assumptions & sources',
  ]);
  for (const n of names) assert.ok(n.length <= 31, `Excel truncates sheet names past 31 characters: ${n}`);
});

check('the cross-sheet formulas point at the rows they claim to', () => {
  // The valuation sheet reads closing equity and the cost of equity out of the
  // other two sheets by hardcoded address. If a row moves on either of those
  // sheets and the shared constants are not moved with it, the workbook still
  // opens and still shows the cached values -- it just quietly recalculates to
  // something else the moment the reader touches a cell. This is the check that
  // catches that, because nothing in the file's own arithmetic can.
  const book = equityBook();
  const sheet = (name: string): Cell[][] => book.find((s) => s.name === name)!.rows;
  const label = (rows: Cell[][], row: number): string => {
    const c = rows[row - 1]?.[0];
    return typeof c === 'object' && c !== null ? String(c.v) : String(c);
  };

  const valuation = sheet('Equity valuation');
  const closing = valuation.find(
    (r) => typeof r[0] === 'string' && r[0].startsWith('Book equity at the end')
  )!;
  const ke = valuation.find((r) => r[0] === 'Cost of equity')!;
  const formulaOf = (cell: unknown) =>
    typeof cell === 'object' && cell !== null && 'f' in (cell as object) ? String((cell as { f?: string }).f) : '';

  // Every row number the two formulas mention must land on the row it names.
  const ecf = sheet('Equity cash flow');
  const coe = sheet('Cost of equity');
  const closingFormula = formulaOf(closing[1]);
  for (const m of closingFormula.matchAll(/!([A-Z]+)(\d+)/g)) {
    const row = Number(m[2]);
    const l = label(ecf, row);
    assert.ok(
      l === 'Opening book equity' || l === 'Increase in book equity',
      `closing equity formula points at row ${row} of the cash flow sheet, which is "${l}"`
    );
  }
  assert.equal(label(coe, Number(formulaOf(ke[1]).match(/!B(\d+)/)![1])), 'Cost of equity');
});

check('the explicit-period sum spans exactly the forecast columns', () => {
  const ecf = equityBook().find((s) => s.name === 'Equity cash flow')!.rows;
  const total = ecf.find(
    (r) => typeof r[0] === 'object' && r[0] !== null && r[0].v === 'PV of explicit equity cash flow'
  )!;
  const cell = total[1] as { v: number; f?: string };
  const m = String(cell.f).match(/^SUM\(C(\d+):([A-Z]+)(\d+)\)$/);
  assert.ok(m, `expected a SUM across the year columns, got ${cell.f}`);
  assert.equal(m![1], m![3], 'the sum must run along a single row');
  // 10 forecast years start at C, so they end at L.
  assert.equal(m![2], 'L');
  assert.ok(close(cell.v, equityDcf(bank({ netIncome: 150 })).pvExplicitEquityCashFlow));
});

console.log('EDGAR tag selection');

// Microsoft's shape: revenue was tagged `Revenues` until ASC 606, then
// `RevenueFromContractWithCustomerExcludingAssessedTax`. The abandoned tag
// stays in companyfacts forever with its last frames intact, so a picker that
// takes the first non-empty tag reads the fiscal-2010 income statement.
function msftShapedFacts(): CompanyFacts {
  const annual = (end: string, start: string, val: number): XbrlFact => ({
    end,
    start,
    val,
    fy: Number(end.slice(0, 4)),
    fp: 'FY',
    form: '10-K',
  });
  return {
    entityName: 'MICROSOFT CORPORATION',
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              annual('2009-06-30', '2008-07-01', 58437000000),
              annual('2010-06-30', '2009-07-01', 62484000000),
            ],
          },
        },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [
              annual('2022-06-30', '2021-07-01', 198270000000),
              annual('2023-06-30', '2022-07-01', 211915000000),
              annual('2024-06-30', '2023-07-01', 245122000000),
              annual('2025-06-30', '2024-07-01', 281724000000),
            ],
          },
        },
        OperatingIncomeLoss: {
          units: { USD: [annual('2025-06-30', '2024-07-01', 128530000000)] },
        },
      },
    },
  };
}

check('a deprecated tag with only old frames does not win over a current one', () => {
  const x = extractFinancials(msftShapedFacts());
  // The label was the visible symptom; the figure is the actual defect. Both
  // come from the same pick, so asserting only the date would let a fix that
  // relabels without repointing the value pass.
  assert.equal(x.fiscalYearEnd, '2025-06-30');
  assert.equal(x.revenue, 281724000000);
});

check('the growth history is measured on the current tag, not the retired one', () => {
  // Two frames exist under `Revenues` and four under the ASC 606 tag. Reading
  // the retired tag would give a 2009-2010 growth rate driving the forecast.
  const x = extractFinancials(msftShapedFacts());
  assert.ok(x.revenueCagr3y !== null);
  const expected = Math.pow(281724000000 / 198270000000, 1 / 3) - 1;
  assert.ok(
    close(x.revenueCagr3y!, expected),
    `expected the 3-year CAGR across the ASC 606 frames, got ${x.revenueCagr3y}`
  );
});

check('tag order still decides when two tags cover the same period', () => {
  // Freshness must not silently reorder preferences. `LongTermDebtNoncurrent`
  // is listed before `LongTermDebt` because the latter often includes the
  // current portion; when both report the same date the first must win.
  const instant = (end: string, val: number): XbrlFact => ({ end, val, fy: 2025, fp: 'FY', form: '10-K' });
  const facts: CompanyFacts = {
    entityName: 'Tie Break Co',
    facts: {
      'us-gaap': {
        LongTermDebtNoncurrent: { units: { USD: [instant('2025-06-30', 100)] } },
        LongTermDebt: { units: { USD: [instant('2025-06-30', 175)] } },
      },
    },
  };
  const f = edgarStatementFacts(facts);
  assert.equal(f.totalDebt, 100);
});

check('StockAnalysis total debt is split from leases without double counting', () => {
  const f = factsFromEdgar({});
  f.source = 'stockanalysis';
  f.revenue = 1000;
  f.ebit = 150;
  f.netPPE = 500;
  f.totalDebt = 300; // standardized total includes the 80 lease liability
  f.operatingLeaseLiabilities = 80;
  const r = reorganize('International Software', f, { marginalTaxRate: 0.25 });
  assert.equal(r.totalDebt, 220);
  assert.equal(r.debtEquivalents, 80);
  assert.equal((r.totalDebt ?? 0) + r.debtEquivalents, 300);
});

check('summary debt fills a missing detailed statement balance', () => {
  const f = factsFromEdgar({});
  f.source = 'stockanalysis';
  f.revenue = 1000;
  f.ebit = 150;
  f.netPPE = 500;
  const r = reorganize('International Software', f, { marginalTaxRate: 0.25, debtFallback: 300 });
  assert.equal(r.totalDebt, 300);
});

console.log('recommendation history screen');

check('the screen requires stress resilience, a decade public, and five non-declining dividends', () => {
  const annual = (year: number, val: number): XbrlFact => ({
    start: `${year - 1}-01-01`, end: `${year}-01-01`, val, fy: year, fp: 'FY', form: '10-K',
  });
  const facts: CompanyFacts = {
    entityName: 'Durable Compounder',
    facts: { 'us-gaap': {
      Revenues: { units: { USD: [
        annual(2008, 100), annual(2009, 105), annual(2014, 150), annual(2015, 160),
        annual(2019, 200), annual(2020, 205), annual(2025, 300),
      ] } },
      CommonStockDividendsPerShareDeclared: { units: { 'USD/shares': [
        annual(2021, 1), annual(2022, 1.1), annual(2023, 1.2), annual(2024, 1.3), annual(2025, 1.4),
      ] } },
    } },
  };
  const screen = screenRecommendationHistory(facts);
  assert.equal(screen.publicAtLeastTenYears, true);
  assert.equal(screen.revenueStressPassed, true);
  assert.equal(screen.dividendGrowthPassed, true);
});

check('one dividend cut fails the recommendation screen', () => {
  const annual = (year: number, val: number): XbrlFact => ({
    start: `${year - 1}-01-01`, end: `${year}-01-01`, val, fy: year, fp: 'FY', form: '10-K',
  });
  const facts: CompanyFacts = { entityName: 'Dividend Cutter', facts: { 'us-gaap': {
    Revenues: { units: { USD: [annual(2010, 100), annual(2014, 120), annual(2015, 125), annual(2019, 150), annual(2020, 151), annual(2025, 190)] } },
    CommonStockDividendsPerShareDeclared: { units: { 'USD/shares': [annual(2021, 1), annual(2022, 1.1), annual(2023, 0.8), annual(2024, 0.9), annual(2025, 1)] } },
  } } };
  assert.equal(screenRecommendationHistory(facts).dividendGrowthPassed, false);
});

console.log('');
if (failures === 0) console.log('all checks passed');
else console.log(failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
