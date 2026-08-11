// Reorganizing the accounting statements into operating vs nonoperating items,
// following Koller, Goedhart & Wessels, "Valuation".
//
//   Ch. 9  -- Reorganizing the Financial Statements: invested capital and NOPAT
//             are built from operating items only; everything else lands in the
//             enterprise-to-equity bridge.
//   Ch. 18 -- Taxes: NOPAT must use an *operating* tax rate, not the effective
//             rate, because the effective rate is contaminated by the tax shield
//             on interest (which the WACC already captures) and by tax on
//             nonoperating income.
//   Ch. 19 -- Nonoperating items, provisions and reserves: excess cash,
//             investments and unfunded obligations are separated out.
//   Ch. 20 -- Leases: lease obligations are debt; the right-of-use asset is
//             operating and belongs in invested capital.
//   Ch. 22 -- Capital-light businesses: R&D is an investment, so it is
//             capitalized and amortized rather than expensed.
//   Part 5 -- Cyclical companies are valued off a normalized base year, and
//             banks/insurers cannot be valued with an enterprise DCF at all.
//
// Every adjustment is applied only when its inputs are actually present in the
// source data. When an input is missing the adjustment is skipped and recorded
// with a reason, so the UI can disclose it instead of the engine guessing.

import { StatementFacts } from './statements';
import { AccountingFramework, Adjustment, LineItem, Reorganization } from './types';

/** Cash needed to run the business, as a share of revenue (Koller Ch. 14). */
const OPERATING_CASH_PCT = 0.02;

/** Straight-line amortization life for capitalized R&D (Koller Ch. 22). */
const RD_LIFE_YEARS = 3;

/** Coefficient of variation in EBIT margin above which a company reads as cyclical. */
const CYCLICAL_CV_THRESHOLD = 0.25;

const FINANCIAL_NAME_PATTERNS = [
  /\bbank(s|ing)?\b/i,
  /\bbanco\b/i,
  /\bbancorp\b/i,
  /\bbankshares\b/i,
  /\binsur/i,
  /\bassurance\b/i,
  /\bre(insurance|assurance)\b/i,
  /\blife\s+(insurance|holdings?)\b/i,
  /\bsavings\b/i,
  /\bcredit\s+(union|agricole)\b/i,
  /银行/,
  /保险/,
  /证券/,
];

export interface ReorganizedInputs {
  accountingFramework: AccountingFramework;
  accountingFrameworkBasis: string;
  reconciliationStatus: 'complete' | 'partial' | 'unresolved';
  revenue: number | null;
  /** EBIT after the R&D and cycle-normalization adjustments. */
  ebit: number | null;
  /** Koller Ch. 18 operating tax rate; null when it cannot be derived. */
  operatingTaxRate: number | null;

  investedCapital: number | null;
  operatingCash: number;
  excessCash: number;
  nonoperatingAssets: number;
  debtEquivalents: number;
  totalDebt: number | null;
  minorityInterest: number | null;

  depreciationAmortization: number | null;
  capex: number | null;
  /** Sign convention: positive = cash outflow (working capital increased). */
  changeInNWC: number | null;

  isFinancial: boolean;
  cyclical: boolean;

  reorganization: Reorganization;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function skipped(label: string, chapter: string, detail: string): Adjustment {
  return { label, chapter, applied: false, detail, effects: [] };
}

// ---------------------------------------------------------------------------
// Part 5: is an enterprise DCF even valid here?
// ---------------------------------------------------------------------------

/**
 * Banks and insurers cannot be valued with an enterprise DCF: debt is raw
 * material rather than financing, so there is no meaningful separation of
 * operating from financing items and no meaningful invested capital. Koller
 * Part 5 uses an equity cash flow model instead.
 */
export function detectFinancial(companyName: string, f: StatementFacts): { isFinancial: boolean; reason: string } {
  for (const p of FINANCIAL_NAME_PATTERNS) {
    if (p.test(companyName)) return { isFinancial: true, reason: `company name matches ${p}` };
  }
  if (f.revenue !== null && f.revenue > 0 && f.interestIncome !== null) {
    const share = f.interestIncome / f.revenue;
    if (share > 0.5) return { isFinancial: true, reason: `interest income is ${(share * 100).toFixed(0)}% of revenue` };
  }
  // Leverage, tested two ways, because how a bank's funding is tagged varies.
  // A debt-share test alone misses the largest bank in the United States:
  // JPMorgan's tagged total debt is 7% of assets, because $2.4tn of customer
  // deposits sits outside the debt tag entirely. What no bank can hide is the
  // other side of the identity -- banks and insurers run at ten to twenty times
  // leverage, and JPMorgan's equity is 7.4% of its assets. Goodwill is checked
  // too, so that an asset-light company levered up in a buyout is not mistaken
  // for a bank: a bank's balance sheet is loans and securities, not purchase
  // premium.
  if (f.totalAssets !== null && f.totalAssets > 0 && f.netPPE !== null) {
    const ppeShare = f.netPPE / f.totalAssets;
    const debtShare = f.totalDebt === null ? null : f.totalDebt / f.totalAssets;
    const equityShare = f.totalEquity === null ? null : f.totalEquity / f.totalAssets;
    const acquiredShare = ((f.goodwill ?? 0) + (f.intangibles ?? 0)) / f.totalAssets;

    if (ppeShare < 0.03 && debtShare !== null && debtShare > 0.5) {
      return {
        isFinancial: true,
        reason: `balance sheet is ${(debtShare * 100).toFixed(0)}% debt-funded with almost no fixed assets`,
      };
    }
    if (ppeShare < 0.03 && acquiredShare < 0.1 && equityShare !== null && equityShare > 0 && equityShare < 0.2) {
      return {
        isFinancial: true,
        reason:
          `equity is only ${(equityShare * 100).toFixed(1)}% of assets, which is bank or insurer leverage, ` +
          `and the balance sheet holds almost no fixed assets (${(ppeShare * 100).toFixed(1)}%) or acquired intangibles`,
      };
    }
  }
  return { isFinancial: false, reason: '' };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Koller Part 5: for cyclical companies the latest year is a poor base, so the
 * forecast starts from a mid-cycle margin. Cyclicality is inferred from the
 * dispersion of historical EBIT margins rather than from an industry label.
 */
export function normalizeCycle(f: StatementFacts): {
  cyclical: boolean;
  normalizedEbit: number | null;
  detail: string;
  currentMargin: number | null;
  medianMargin: number | null;
} {
  const n = Math.min(f.revenueHistory.length, f.ebitHistory.length);
  if (n < 4) {
    return {
      cyclical: false,
      normalizedEbit: null,
      detail: `only ${n} year(s) of margin history available; need 4 to judge cyclicality`,
      currentMargin: null,
      medianMargin: null,
    };
  }
  const margins: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = f.revenueHistory[i];
    if (r > 0) margins.push(f.ebitHistory[i] / r);
  }
  if (margins.length < 4) {
    return { cyclical: false, normalizedEbit: null, detail: 'margin history incomplete', currentMargin: null, medianMargin: null };
  }

  const m = mean(margins);
  const sd = Math.sqrt(mean(margins.map((x) => (x - m) * (x - m))));
  const cv = m !== 0 ? Math.abs(sd / m) : 0;
  const med = median(margins);
  const current = margins[0];

  if (cv <= CYCLICAL_CV_THRESHOLD) {
    return {
      cyclical: false,
      normalizedEbit: null,
      detail: `EBIT-margin coefficient of variation ${cv.toFixed(2)} over ${margins.length}y is below the ${CYCLICAL_CV_THRESHOLD} cyclicality threshold`,
      currentMargin: current,
      medianMargin: med,
    };
  }

  const revenue = f.revenue ?? f.revenueHistory[0];
  return {
    cyclical: true,
    normalizedEbit: revenue * med,
    detail: `EBIT-margin coefficient of variation ${cv.toFixed(2)} over ${margins.length}y exceeds ${CYCLICAL_CV_THRESHOLD}; base-year EBIT reset to revenue x median margin ${(med * 100).toFixed(1)}% (latest year was ${(current * 100).toFixed(1)}%)`,
    currentMargin: current,
    medianMargin: med,
  };
}

// ---------------------------------------------------------------------------
// Ch. 18: operating tax rate
// ---------------------------------------------------------------------------

/**
 * Operating cash taxes, backed out of the reported tax provision:
 *
 *   operating taxes = tax provision
 *                   + marginal rate x interest expense   (remove the tax shield)
 *                   - marginal rate x interest income    (remove tax on nonop.)
 *
 * The interest tax shield is deliberately excluded from NOPAT because the WACC
 * already reflects it through the after-tax cost of debt (Koller Ch. 13/18).
 */
export function operatingTaxRate(
  f: StatementFacts,
  ebit: number | null,
  marginalRate: number
): { rate: number | null; detail: string; effectiveRate: number | null } {
  const effectiveRate =
    f.incomeTaxExpense !== null && f.pretaxIncome !== null && f.pretaxIncome > 0
      ? f.incomeTaxExpense / f.pretaxIncome
      : null;

  if (f.incomeTaxExpense === null || ebit === null || ebit <= 0) {
    return {
      rate: null,
      detail: 'tax provision or EBIT unavailable; falling back to the effective tax rate',
      effectiveRate,
    };
  }

  const shield = marginalRate * num(f.interestExpense);
  const nonopTax = marginalRate * num(f.interestIncome);
  const operatingTaxes = f.incomeTaxExpense + shield - nonopTax;
  const raw = operatingTaxes / ebit;

  if (!isFinite(raw) || raw < 0.02 || raw > 0.6) {
    return {
      rate: null,
      detail: `implied operating tax rate ${(raw * 100).toFixed(1)}% is outside the plausible 2-60% range; falling back to the effective rate`,
      effectiveRate,
    };
  }

  const effTxt = effectiveRate === null ? 'n/a' : `${(effectiveRate * 100).toFixed(1)}%`;
  return {
    rate: raw,
    detail: `tax provision plus ${(marginalRate * 100).toFixed(0)}% marginal-rate adjustment for the interest tax shield, over EBIT: ${(raw * 100).toFixed(1)}% vs ${effTxt} effective`,
    effectiveRate,
  };
}

// ---------------------------------------------------------------------------
// Ch. 22: capitalize R&D
// ---------------------------------------------------------------------------

/**
 * Treat R&D as an investment. With straight-line amortization over L years,
 * spend from i years ago retains (L - i) / L of its value, so:
 *
 *   asset          = sum_i r[i] x (L - i) / L
 *   amortization   = sum_i r[i] / L
 *   adjusted EBIT  = EBIT + r[0] - amortization
 *
 * `researchDevelopmentHistory` runs most-recent-first.
 */
export function capitalizeRnd(
  history: number[],
  life = RD_LIFE_YEARS
): { asset: number; amortization: number; currentSpend: number; years: number } | null {
  const r = history.filter((x) => typeof x === 'number' && isFinite(x) && x > 0).slice(0, life);
  if (r.length === 0) return null;

  let asset = 0;
  let amortization = 0;
  for (let i = 0; i < r.length; i++) {
    asset += (r[i] * (life - i)) / life;
    amortization += r[i] / life;
  }
  return { asset, amortization, currentSpend: r[0], years: r.length };
}

// ---------------------------------------------------------------------------
// The full reorganization
// ---------------------------------------------------------------------------

export function reorganize(
  companyName: string,
  f: StatementFacts,
  opts: { marginalTaxRate: number; cashFallback?: number | null; debtFallback?: number | null }
): ReorganizedInputs {
  const adjustments: Adjustment[] = [];

  const accountingFramework = f.accountingFramework;
  const accountingFrameworkBasis =
    accountingFramework === 'us-gaap'
      ? 'U.S. GAAP concepts from SEC EDGAR were used for the balance-sheet and financing-side mapping.'
      : accountingFramework === 'ifrs'
        ? 'IFRS concepts were selected for this non-U.S. or foreign-private-issuer filing; equivalent labels were normalized into the Koller schedule.'
        : 'The source did not expose an accounting-framework marker; mappings are conservative and unresolved rows remain visible.';
  adjustments.push({
    label: 'Select accounting framework',
    chapter: 'Ch. 9 (reorganizing the statements)',
    applied: accountingFramework !== 'unknown',
    detail: accountingFrameworkBasis,
    effects: [],
  });

  // --- Part 5 guard: banks and insurers -----------------------------------
  const fin = detectFinancial(companyName, f);
  adjustments.push(
    fin.isFinancial
      ? {
          label: 'Financial institution detected',
          chapter: 'Part 5 (banks and insurers)',
          applied: true,
          detail: `An enterprise DCF is not valid for this filer (${fin.reason}). For a bank or insurer, debt is raw material rather than financing, so invested capital and free cash flow are not meaningful. Koller values these with an equity cash flow model.`,
          effects: [],
        }
      : skipped(
          'Financial institution detected',
          'Part 5 (banks and insurers)',
          'Filer does not look like a bank or insurer, so the enterprise DCF applies.'
        )
  );

  // --- Ch. 14/19: operating vs excess cash --------------------------------
  const revenue = f.revenue;
  // The balance sheet is the primary source, but when no cash alias resolves
  // there the caller's overview figure is used instead. Without this the whole
  // cash balance silently reads as zero and the bridge adds nothing back.
  const cashFromFallback = f.cash === null && opts.cashFallback != null;
  const cash = num(f.cash ?? opts.cashFallback);
  const operatingCash =
    revenue !== null && revenue > 0 ? Math.min(cash, OPERATING_CASH_PCT * revenue) : cash;
  const excessCash = Math.max(cash - operatingCash, 0) + num(f.shortTermInvestments);

  adjustments.push({
    label: 'Split operating from excess cash',
    chapter: 'Ch. 14 (enterprise to equity)',
    applied: revenue !== null && revenue > 0,
    detail:
      revenue !== null && revenue > 0
        ? `Operating cash held at ${(OPERATING_CASH_PCT * 100).toFixed(0)}% of revenue; the remainder plus short-term investments is a nonoperating asset added back in the bridge.${cashFromFallback ? ' The balance sheet carried no cash line, so the overview cash balance was used.' : ''}`
        : 'Revenue unavailable, so the full cash balance is treated as operating.',
    effects: [
      { field: 'operatingCash', from: cash, to: operatingCash },
      { field: 'excessCash', from: 0, to: excessCash },
    ],
  });

  // --- Ch. 19: nonoperating assets ---------------------------------------
  const nonoperatingAssetsBuild: LineItem[] = [
    { label: 'Excess cash and short-term investments', value: excessCash, note: `cash above ${(OPERATING_CASH_PCT * 100).toFixed(0)}% of revenue` },
  ];
  if (f.longTermInvestments !== null) {
    nonoperatingAssetsBuild.push({ label: 'Long-term investments', value: f.longTermInvestments });
  }
  if (f.equityInvestments !== null) {
    nonoperatingAssetsBuild.push({
      label: 'Equity-method investments',
      value: f.equityInvestments,
      note: 'earnings sit below the operating line, so the stake is valued separately',
    });
  }
  if (f.financialSubsidiaries !== null) {
    nonoperatingAssetsBuild.push({ label: 'Financial subsidiaries', value: f.financialSubsidiaries });
  }
  if (f.otherNonoperatingAssets !== null) {
    nonoperatingAssetsBuild.push({ label: 'Other nonoperating assets', value: f.otherNonoperatingAssets });
  }
  // Excess cash is shown in the build list because it is conceptually a
  // nonoperating asset, but it is returned as its own field so the Ch. 14
  // bridge can show it on a separate line without double counting.
  const nonoperatingAssets = num(f.longTermInvestments) + num(f.equityInvestments) +
    num(f.financialSubsidiaries) + num(f.otherNonoperatingAssets);

  adjustments.push({
    label: 'Separate nonoperating assets',
    chapter: 'Ch. 19 (nonoperating items)',
    applied: f.longTermInvestments !== null || f.equityInvestments !== null,
    detail:
      f.longTermInvestments !== null || f.equityInvestments !== null
        ? 'Investments excluded from invested capital and added back in the enterprise-to-equity bridge.'
        : 'No investment balances found on the balance sheet; only excess cash is treated as nonoperating.',
    effects: [{ field: 'nonoperatingAssets', from: 0, to: nonoperatingAssets }],
  });

  // --- Ch. 20: leases ----------------------------------------------------
  const leaseLiability = f.operatingLeaseLiabilities;
  // Under IFRS 16 / ASC 842 the liability is already on the balance sheet, but
  // it is usually reported outside "total debt". The right-of-use asset is
  // operating and belongs in invested capital; if it is not disclosed
  // separately, the liability is the standard proxy for it.
  const rouAsset = f.operatingLeaseAssets ?? leaseLiability;
  adjustments.push(
    leaseLiability !== null && leaseLiability > 0
      ? {
          label: 'Capitalize operating leases',
          chapter: 'Ch. 20 (leases)',
          applied: true,
          detail:
            f.operatingLeaseAssets !== null
              ? 'Lease liability treated as debt in the capital structure and the bridge; the disclosed right-of-use asset is included in invested capital.'
              : 'Lease liability treated as debt in the capital structure and the bridge; the right-of-use asset is not disclosed separately, so the liability is used as its proxy in invested capital.',
          effects: [
            { field: 'debtEquivalents', from: 0, to: leaseLiability },
            { field: 'investedCapital (ROU asset)', from: 0, to: num(rouAsset) },
          ],
        }
      : skipped(
          'Capitalize operating leases',
          'Ch. 20 (leases)',
          'No operating-lease liability found in the source data, so no lease capitalization was applied. Under IFRS 16 / ASC 842 material leases are already on the balance sheet and may be inside reported total debt.'
        )
  );

  // --- Ch. 19: provisions and other debt equivalents ---------------------
  const debtEquivalentsBuild: LineItem[] = [];
  if (leaseLiability !== null && leaseLiability > 0) {
    debtEquivalentsBuild.push({ label: 'Operating lease liabilities', value: leaseLiability, note: 'Ch. 20' });
  }
  if (f.pensionObligations !== null && f.pensionObligations > 0) {
    debtEquivalentsBuild.push({ label: 'Unfunded pension and retirement obligations', value: f.pensionObligations, note: 'Ch. 19' });
  }
  if (f.restructuringReserves !== null && f.restructuringReserves > 0) {
    debtEquivalentsBuild.push({ label: 'Restructuring reserves', value: f.restructuringReserves, note: 'Ch. 19' });
  }
  const debtEquivalents = debtEquivalentsBuild.reduce((s, l) => s + l.value, 0);
  // StockAnalysis's standardized Total Debt includes the current and long-term
  // lease rows (SAP is an observable example). Once leases are shown as debt
  // equivalents, remove them from financing debt to avoid a double deduction.
  const reportedDebt = f.totalDebt ?? opts.debtFallback ?? null;
  const totalDebt =
    reportedDebt !== null && f.source === 'stockanalysis' && leaseLiability !== null
      ? Math.max(reportedDebt - leaseLiability, 0)
      : reportedDebt;

  adjustments.push(
    (f.pensionObligations !== null && f.pensionObligations > 0) ||
    (f.restructuringReserves !== null && f.restructuringReserves > 0)
      ? {
          label: 'Provisions as debt equivalents',
          chapter: 'Ch. 19 (provisions)',
          applied: true,
          detail: 'Unfunded retirement obligations and restructuring reserves are debt-like: deducted in the bridge and weighted as debt in the WACC.',
          effects: [{ field: 'debtEquivalents', from: leaseLiability ?? 0, to: debtEquivalents }],
        }
      : skipped(
          'Provisions as debt equivalents',
          'Ch. 19 (provisions)',
          'No pension, retirement, or restructuring-reserve line found in the source data.'
        )
  );

  // --- Part 5: cycle normalization, then Ch. 22 R&D ----------------------
  const cycle = normalizeCycle(f);
  let ebit = f.ebit;
  if (cycle.cyclical && cycle.normalizedEbit !== null) {
    adjustments.push({
      label: 'Normalize the base year for the cycle',
      chapter: 'Part 5 (cyclical companies)',
      applied: true,
      detail: cycle.detail,
      effects: [{ field: 'ebit', from: ebit, to: cycle.normalizedEbit }],
    });
    ebit = cycle.normalizedEbit;
  } else {
    adjustments.push(skipped('Normalize the base year for the cycle', 'Part 5 (cyclical companies)', cycle.detail));
  }

  if (f.restructuringCharges !== null && f.restructuringCharges > 0 && ebit !== null) {
    const before = ebit;
    ebit += f.restructuringCharges;
    adjustments.push({
      label: 'Remove nonoperating restructuring charges', chapter: 'Ch. 19 (provisions)', applied: true,
      detail: 'Current restructuring charge removed from operating profit; the related reserve is treated as a debt equivalent when disclosed.',
      effects: [{ field: 'ebit', from: before, to: ebit }],
    });
  } else {
    adjustments.push(skipped('Remove nonoperating restructuring charges', 'Ch. 19 (provisions)', 'No separately identified current restructuring charge was available.'));
  }

  const rnd = capitalizeRnd(f.researchDevelopmentHistory.length > 0 ? f.researchDevelopmentHistory : f.researchDevelopment !== null ? [f.researchDevelopment] : []);
  let rndAsset = 0;
  if (rnd !== null && ebit !== null) {
    const adjustedEbit = ebit + rnd.currentSpend - rnd.amortization;
    adjustments.push({
      label: 'Capitalize R&D',
      chapter: 'Ch. 22 (capital-light businesses)',
      applied: true,
      detail: `R&D capitalized over ${RD_LIFE_YEARS} years using ${rnd.years} year(s) of history. Current-year spend added back to EBIT and replaced with straight-line amortization; the unamortized balance is added to invested capital.`,
      effects: [
        { field: 'ebit', from: ebit, to: adjustedEbit },
        { field: 'investedCapital (capitalized R&D)', from: 0, to: rnd.asset },
      ],
    });
    ebit = adjustedEbit;
    rndAsset = rnd.asset;
  } else {
    adjustments.push(
      skipped(
        'Capitalize R&D',
        'Ch. 22 (capital-light businesses)',
        rnd === null
          ? 'No R&D expense reported, so there is nothing to capitalize.'
          : 'EBIT unavailable, so the R&D adjustment could not be applied.'
      )
    );
  }

  // --- Ch. 9: invested capital build -------------------------------------
  // Prefer a line-by-line operating build: remove nonoperating cash and
  // marketable securities from current assets, and financing debt/leases from
  // current liabilities. Fall back to reported net working capital only when
  // the two sides are unavailable.
  const operatingWorkingCapital =
    f.currentAssets !== null && f.currentLiabilities !== null
      ? f.currentAssets - cash - num(f.shortTermInvestments) -
        (f.currentLiabilities - num(f.shortTermDebt) - num(f.currentLeaseLiabilities))
      : f.workingCapital === null ? null : f.workingCapital - excessCash;

  const investedCapitalBuild: LineItem[] = [];
  if (f.netPPE !== null) investedCapitalBuild.push({ label: 'Net property, plant and equipment', value: f.netPPE });
  if (operatingWorkingCapital !== null) {
    investedCapitalBuild.push({
      label: 'Operating working capital',
      value: operatingWorkingCapital,
      note: f.currentAssets !== null && f.currentLiabilities !== null
        ? 'operating current assets less noninterest-bearing operating current liabilities'
        : 'fallback: reported net working capital less excess cash',
    });
  }
  if (f.goodwill !== null && f.goodwill > 0) {
    investedCapitalBuild.push({ label: 'Goodwill and acquired intangibles', value: f.goodwill });
  }
  if (f.intangibles !== null && f.intangibles > 0 && f.goodwill !== f.intangibles) {
    investedCapitalBuild.push({ label: 'Other intangible assets', value: f.intangibles });
  }
  if (rouAsset !== null && rouAsset > 0) {
    investedCapitalBuild.push({ label: 'Right-of-use lease asset', value: rouAsset, note: 'Ch. 20' });
  }
  if (rndAsset > 0) {
    investedCapitalBuild.push({ label: 'Capitalized R&D', value: rndAsset, note: 'Ch. 22' });
  }
  const otherOperatingAssets = Math.max(
    num(f.otherOperatingAssets) - num(f.deferredTaxAssets) - num(f.overfundedPensionAssets), 0
  );
  const otherOperatingLiabilities = Math.max(
    num(f.otherOperatingLiabilities) - num(f.deferredTaxLiabilities) - num(f.pensionObligations) - num(f.restructuringReserves), 0
  );
  const otherOperatingNet = otherOperatingAssets - otherOperatingLiabilities;
  if (f.otherOperatingAssets !== null || f.otherOperatingLiabilities !== null) {
    investedCapitalBuild.push({
      label: 'Other operating assets, net of liabilities',
      value: otherOperatingNet,
      note: 'residual long-term operating balances after separately classified tax, pension and restructuring items',
    });
  }

  const haveCore = f.netPPE !== null || operatingWorkingCapital !== null;
  const investedCapital = haveCore ? investedCapitalBuild.reduce((s, l) => s + l.value, 0) : null;

  adjustments.push(
    haveCore
      ? {
          label: 'Build invested capital from the balance sheet',
          chapter: 'Ch. 9 (reorganizing the statements)',
          applied: true,
          detail: 'Invested capital assembled from operating assets only, rather than inferred from an assumed ROIC.',
          effects: [{ field: 'investedCapital', from: null, to: investedCapital }],
        }
      : skipped(
          'Build invested capital from the balance sheet',
          'Ch. 9 (reorganizing the statements)',
          'Neither net PP&E nor working capital resolved in the source data, so invested capital must be estimated from an assumed ROIC.'
        )
  );

  // --- Ch. 18: operating taxes -------------------------------------------
  const tax = operatingTaxRate(f, ebit, opts.marginalTaxRate);
  adjustments.push(
    tax.rate !== null
      ? {
          label: 'Operating tax rate instead of effective',
          chapter: 'Ch. 18 (taxes)',
          applied: true,
          detail: tax.detail,
          effects: [{ field: 'taxRate', from: tax.effectiveRate, to: tax.rate }],
        }
      : skipped('Operating tax rate instead of effective', 'Ch. 18 (taxes)', tax.detail)
  );

  // Cash-flow statements report the working-capital movement as a cash effect
  // (negative = cash used). Our convention is positive = outflow.
  const changeInNWC = f.changeInNWC === null ? null : -f.changeInNWC;

  if (f.overfundedPensionAssets !== null && f.overfundedPensionAssets > 0) {
    nonoperatingAssetsBuild.push({ label: 'Overfunded pension assets', value: f.overfundedPensionAssets });
  }
  if (f.deferredTaxAssets !== null && f.deferredTaxAssets > 0) {
    nonoperatingAssetsBuild.push({ label: 'Deferred tax assets / tax attributes', value: f.deferredTaxAssets, note: 'proxy where tax-loss carryforwards are not separately tagged' });
  }
  const expandedNonoperatingAssets = nonoperatingAssets + num(f.overfundedPensionAssets) + num(f.deferredTaxAssets);
  const totalFundsInvested = num(investedCapital) + excessCash + expandedNonoperatingAssets;

  const commonEquity = f.totalEquity === null ? null : Math.max(f.totalEquity - num(f.minorityInterest) - num(f.hybridSecurities), 0);
  const financingBuild: LineItem[] = [];
  if (totalDebt !== null) financingBuild.push({ label: 'Financing debt', value: totalDebt });
  if (debtEquivalents > 0) financingBuild.push({ label: 'Debt equivalents', value: debtEquivalents });
  if (commonEquity !== null) financingBuild.push({ label: 'Common equity', value: commonEquity });
  if (f.deferredTaxLiabilities !== null) financingBuild.push({ label: 'Deferred-tax equity equivalents', value: f.deferredTaxLiabilities });
  if (f.hybridSecurities !== null) financingBuild.push({ label: 'Hybrid securities', value: f.hybridSecurities });
  if (f.minorityInterest !== null) financingBuild.push({ label: 'Noncontrolling interests', value: f.minorityInterest });
  const financingComplete = totalDebt !== null && commonEquity !== null;
  const financingTotal = financingComplete ? financingBuild.reduce((sum, item) => sum + item.value, 0) : null;
  const financingReconciliationGap = financingTotal === null ? null : totalFundsInvested - financingTotal;
  const reconciliationStatus =
    financingTotal === null
      ? 'unresolved'
      : Math.abs(financingReconciliationGap ?? Infinity) <= Math.max(Math.abs(totalFundsInvested) * 0.01, 1)
        ? 'complete'
        : 'partial';

  const nopat = ebit !== null && (tax.rate ?? tax.effectiveRate) !== null
    ? ebit * (1 - (tax.rate ?? tax.effectiveRate as number)) : null;
  const netCapex = f.capex === null ? null : f.capex - num(f.assetDisposals);
  const changeLeaseAssets = f.operatingLeaseAssetsHistory.length >= 2
    ? f.operatingLeaseAssetsHistory[0] - f.operatingLeaseAssetsHistory[1] : null;
  const changeOtherOperatingNet = f.otherOperatingAssetsHistory.length >= 2 && f.otherOperatingLiabilitiesHistory.length >= 2
    ? (f.otherOperatingAssetsHistory[0] - f.otherOperatingAssetsHistory[1]) -
      (f.otherOperatingLiabilitiesHistory[0] - f.otherOperatingLiabilitiesHistory[1]) : null;
  const historicalFcfBuild: LineItem[] = [];
  if (nopat !== null) historicalFcfBuild.push({ label: 'NOPAT', value: nopat });
  if (f.depreciationAmortization !== null) historicalFcfBuild.push({ label: 'Noncash operating expenses (D&A)', value: f.depreciationAmortization });
  if (changeInNWC !== null) historicalFcfBuild.push({ label: 'Investment in operating working capital', value: -changeInNWC });
  if (netCapex !== null) historicalFcfBuild.push({ label: 'Capital expenditure, net of disposals', value: -netCapex });
  if (f.acquisitions !== null) historicalFcfBuild.push({ label: 'Investment in acquired intangibles and goodwill', value: -Math.abs(f.acquisitions) });
  if (changeLeaseAssets !== null) historicalFcfBuild.push({ label: 'Change in capitalized operating leases', value: -changeLeaseAssets });
  if (changeOtherOperatingNet !== null) historicalFcfBuild.push({ label: 'Change in other long-term operating assets, net of liabilities', value: -changeOtherOperatingNet });
  const historicalFcfComplete = nopat !== null && f.depreciationAmortization !== null && changeInNWC !== null && netCapex !== null;
  const historicalFreeCashFlow = historicalFcfComplete
    ? (nopat as number) + f.depreciationAmortization! - changeInNWC! - netCapex! - Math.abs(f.acquisitions ?? 0) -
      (changeLeaseAssets ?? 0) - (changeOtherOperatingNet ?? 0)
    : null;

  const investorFlowBuild: LineItem[] = [];
  if (f.interestExpense !== null) investorFlowBuild.push({ label: 'Interest paid to lenders', value: f.interestExpense });
  if (f.debtRepayment !== null) investorFlowBuild.push({ label: 'Debt repayments', value: Math.abs(f.debtRepayment) });
  if (f.debtIssuance !== null) investorFlowBuild.push({ label: 'Less: debt issued', value: -Math.abs(f.debtIssuance) });
  if (f.dividendsPaid !== null) investorFlowBuild.push({ label: 'Dividends', value: Math.abs(f.dividendsPaid) });
  if (f.shareRepurchases !== null) investorFlowBuild.push({ label: 'Share repurchases', value: Math.abs(f.shareRepurchases) });
  if (f.shareIssuance !== null) investorFlowBuild.push({ label: 'Less: shares issued', value: -Math.abs(f.shareIssuance) });
  const investorFlowComplete = [f.interestExpense, f.debtRepayment, f.debtIssuance, f.dividendsPaid, f.shareRepurchases, f.shareIssuance].every((value) => value !== null);
  const investorFlowTotal = investorFlowComplete ? investorFlowBuild.reduce((sum, item) => sum + item.value, 0) : null;
  const investorFlowReconciliationGap = investorFlowTotal === null || historicalFreeCashFlow === null
    ? null : historicalFreeCashFlow - investorFlowTotal;

  return {
    accountingFramework,
    accountingFrameworkBasis,
    reconciliationStatus,
    revenue,
    ebit,
    operatingTaxRate: tax.rate ?? tax.effectiveRate,
    investedCapital,
    operatingCash,
    excessCash,
    nonoperatingAssets: expandedNonoperatingAssets,
    debtEquivalents,
    totalDebt,
    minorityInterest: f.minorityInterest,
    depreciationAmortization: f.depreciationAmortization,
    capex: f.capex,
    changeInNWC,
    isFinancial: fin.isFinancial,
    cyclical: cycle.cyclical,
    reorganization: {
      accountingFramework,
      accountingFrameworkBasis,
      reconciliationStatus,
      investedCapitalBuild,
      nonoperatingAssetsBuild,
      debtEquivalentsBuild,
      totalFundsInvested,
      financingBuild,
      financingTotal,
      financingReconciliationGap,
      historicalFcfBuild,
      historicalFreeCashFlow,
      investorFlowBuild,
      investorFlowTotal,
      investorFlowReconciliationGap,
      adjustments,
    },
  };
}
