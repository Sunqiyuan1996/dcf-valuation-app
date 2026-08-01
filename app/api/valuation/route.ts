import { NextRequest, NextResponse } from 'next/server';
import {
  resolveTickerToCik,
  fetchCompanyFacts,
  extractFinancials,
  edgarStatementFacts,
  SecExtract,
} from '@/lib/secEdgar';
import { fetchGovernmentBondYield } from '@/lib/yahooFinance';
import {
  classifyTicker,
  saResolve,
  saPrice,
  saOverview,
  eastmoneyQuote,
  twelveDataPrice,
  SaListing,
  SUPPORTED_EXCHANGES_HELP,
} from '@/lib/globalData';
import { saStatementFacts, StatementFacts } from '@/lib/statements';
import { reorganize, ReorganizedInputs } from '@/lib/adjustments';
import { costOfDebt, localRiskFreeRate, marketParams } from '@/lib/costOfCapital';
import { appendDerivedRows, fmtMoney, fmtPct, QualityLog } from '@/lib/dataQuality';
import { calculateWacc, defaultAssumptions, runDcf } from '@/lib/dcf';
import { estimateBeta } from '@/lib/beta';
import { equityDcf, EquityDcfResult } from '@/lib/equityDcf';
import { DcfAssumptions, Financials, Reorganization } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RequestBody {
  ticker: string;
  assumptionOverrides?: Partial<DcfAssumptions>;
  financialOverrides?: Partial<Financials>;
}

const DEFAULT_RISK_FREE_RATE = 0.043;
/** Statutory rate used to strip the interest tax shield out of the tax provision (Ch. 18). */
const DEFAULT_MARGINAL_TAX_RATE = 0.25;
/** Last-resort ROIC for inferring invested capital when the balance sheet is unusable. */
const FALLBACK_ROIC = 0.15;

/** Empty extract for listings where no fundamentals source succeeded. */
function emptySecExtract(ticker: string): SecExtract {
  return {
    companyName: ticker,
    fiscalYearEnd: 'unknown',
    revenue: null,
    ebit: null,
    effectiveTaxRate: null,
    depreciationAmortization: null,
    capex: null,
    changeInNWC: null,
    investedCapital: null,
    totalDebt: null,
    cashAndEquivalents: null,
    minorityInterest: null,
    revenueCagr3y: null,
    interestExpense: null,
    sharesOutstanding: null,
    missing: [],
  };
}

/** Plain-English names for the manual-entry fields, used in the prompt text. */
const HUMAN_FIELD: Record<string, string> = {
  netIncome: 'net income attributable to common shareholders',
  bookEquity: 'common book equity',
  sharePrice: 'share price',
  sharesOutstanding: 'shares outstanding',
};

/**
 * Refusal message for a listing that resolved onto an exchange other than the
 * one the suffix asked for, or null when the match is good.
 *
 * Asked for HSBC on London the search returns "bcba/hsbc", the Buenos Aires
 * CEDEAR: quoted in pesos against dollar financials, and carrying no statements
 * at all. That is a different security, not a near miss, so it is refused
 * rather than valued.
 */
function exchangeMismatch(ticker: string, symbol: string, exchangeName: string, listing: SaListing | null): string | null {
  if (!listing || listing.exchangeMatched) return null;
  const found = listing.foundOn.length > 0 ? listing.foundOn.join(', ') : 'other exchanges';
  return (
    `"${ticker}" was not found on ${exchangeName}. The symbol "${symbol}" does exist on ${found}, ` +
    `but those are separate listings quoted in different currencies, so they are not used as a substitute. ` +
    `Local tickers often differ from the international one — HSBC, for example, trades in London as HSBA.L.`
  );
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // A trailing dot is a typing slip, not an exchange suffix ("601398.SS." for
  // "601398.SS"). Left in, it fails resolution and reads as an unsupported market.
  const ticker = body.ticker?.trim().toUpperCase().replace(/\.+$/, '');
  if (!ticker) {
    return NextResponse.json({ error: 'A ticker symbol is required.' }, { status: 400 });
  }

  const estimatedFields: string[] = [];
  const log = new QualityLog();
  const cls = classifyTicker(ticker);
  const market = marketParams(cls?.suffix ?? 'US');

  // 1. Fundamentals + market quote, routed by exchange:
  //    - US (no suffix / .US): SEC EDGAR XBRL fundamentals; price from
  //      stockanalysis.com with Twelve Data as optional keyed fallback.
  //    - China A (.SS/.SH/.SZ): price/shares/market cap from Eastmoney;
  //      fundamentals from stockanalysis.com.
  //    - Other supported exchanges (OECD ex-LatAm + .HK): price and
  //      fundamentals from stockanalysis.com.
  //    Anything the sources miss falls through to the manual-entry form.
  let secExtract: SecExtract;
  let facts: StatementFacts | null = null;
  let listing: SaListing | null = null;
  let companyTitle = ticker;
  let currency = market.currency;
  let isInternational = false;
  const quote: { price: number | null; marketCap: number | null; sharesOutstanding: number | null; beta: number | null } =
    { price: null, marketCap: null, sharesOutstanding: null, beta: null };

  try {
    if (!cls || cls.market === 'US') {
      // cls === null covers unknown suffixes; US class shares like BRK.B are
      // in EDGAR, so only reject after the EDGAR lookup also misses.
      const symbol = cls?.symbol ?? ticker;
      const resolved = await resolveTickerToCik(symbol);
      if (!resolved) {
        return NextResponse.json(
          {
            error:
              cls === null
                ? `"${ticker}" is not a US listing and its exchange suffix is not supported. ${SUPPORTED_EXCHANGES_HELP}`
                : `"${ticker}" was not found in SEC EDGAR. ${SUPPORTED_EXCHANGES_HELP}`,
          },
          { status: 404 }
        );
      }
      companyTitle = resolved.title;
      currency = 'USD';
      const companyFacts = await fetchCompanyFacts(resolved.cik);
      secExtract = extractFinancials(companyFacts);
      facts = edgarStatementFacts(companyFacts);
      quote.price = (await saPrice(symbol.toLowerCase())) ?? (await twelveDataPrice(symbol));
      log.add('Share price', String(quote.price ?? 'n/a'), 'stockanalysis.com quote', 'source');
    } else if (cls.market === 'CN-A') {
      isInternational = true;
      const [cn, resolvedListing] = await Promise.all([
        eastmoneyQuote(cls.symbol, cls.suffix as string),
        saResolve(cls.symbol, cls.exchange!),
      ]);
      listing = resolvedListing;
      const mismatch = exchangeMismatch(ticker, cls.symbol, cls.exchange!.name, listing);
      if (mismatch) return NextResponse.json({ error: mismatch }, { status: 404 });
      const ov = listing ? await saOverview(listing) : null;
      secExtract = ov?.fundamentals ?? emptySecExtract(ticker);
      if (listing) facts = await saStatementFacts(listing);
      // The resolved listing's English name is the fallback, not the bare
      // ticker. It matters more than a label: the name is one of the three
      // tests that decide whether a filer is valued as a bank, and when
      // Eastmoney comes back empty the ticker "601398.SS" matches nothing —
      // so ICBC, with no statements to fall back on either, would be routed
      // into the enterprise model it cannot use.
      companyTitle =
        cn.name ?? listing?.name ?? (secExtract.companyName !== ticker ? secExtract.companyName : ticker);
      currency = ov?.financialCurrency ?? market.currency;
      // Eastmoney quote (CNY, same as the financials) is primary; the
      // stockanalysis overview fills any gaps.
      quote.price = cn.price ?? ov?.price ?? null;
      quote.sharesOutstanding = cn.sharesOutstanding ?? ov?.sharesOutstanding ?? null;
      quote.marketCap = cn.marketCap ?? ov?.marketCap ?? null;
      log.add(
        'Share price',
        String(quote.price ?? 'n/a'),
        cn.price !== null ? 'Eastmoney real-time quote (CNY, same currency as the financials)' : 'stockanalysis.com quote',
        'source'
      );
    } else {
      isInternational = true;
      listing = await saResolve(cls.symbol, cls.exchange!);
      const mismatch = exchangeMismatch(ticker, cls.symbol, cls.exchange!.name, listing);
      if (mismatch) return NextResponse.json({ error: mismatch }, { status: 404 });
      const ov = listing ? await saOverview(listing) : null;
      if (listing) {
        companyTitle = listing.name;
        facts = await saStatementFacts(listing);
      }
      secExtract = ov?.fundamentals ?? emptySecExtract(ticker);
      if (ov) {
        quote.price = ov.price;
        quote.sharesOutstanding = ov.sharesOutstanding;
        quote.marketCap = ov.marketCap;
        currency = ov.financialCurrency ?? market.currency;
        if (ov.priceConverted) {
          estimatedFields.push('sharePrice (currency-converted)');
          log.add(
            'Share price',
            String(ov.price ?? 'n/a'),
            `quoted in ${ov.priceCurrency}, converted to ${ov.financialCurrency} so the price and the financials share one currency`,
            'derived'
          );
        } else {
          log.add('Share price', String(ov.price ?? 'n/a'), 'stockanalysis.com quote', 'source');
        }
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Failed to fetch company data: ${e.message}` }, { status: 502 });
  }

  // The price rows above were written before the reporting currency was known,
  // so restate the value now that it is settled.
  if (quote.price !== null) log.setValue('Share price', fmtMoney(quote.price, currency));

  // 2. Reorganize the statements into operating vs nonoperating items
  //    (Koller Ch. 9, 14, 18, 19, 20, 22 and the Part 5 special cases).
  let reorg: ReorganizedInputs | null = null;
  if (facts !== null) {
    reorg = reorganize(companyTitle, facts, {
      marginalTaxRate: DEFAULT_MARGINAL_TAX_RATE,
      cashFallback: secExtract.cashAndEquivalents,
      debtFallback: secExtract.totalDebt,
    });
  }

  // Cash drives the excess-cash add-back, and picking a balance sheet is a
  // judgment call: the latest one on file is used even when it is a quarter,
  // because the bridge is struck as of today. Say which one, and say loudly
  // when no cash line was found at all rather than letting a zero pass.
  const cashSrc = facts?.cashSource ?? null;
  if (cashSrc !== null && facts?.cash != null) {
    log.add(
      'Cash and equivalents',
      fmtMoney(facts.cash, currency),
      `${facts.source === 'edgar' ? 'SEC EDGAR XBRL tag' : 'balance sheet line'} "${cashSrc.field}", ` +
        (cashSrc.period === ''
          ? 'from the most recent column, which the source did not label with a date'
          : cashSrc.interim
            ? `as of ${cashSrc.period}. That is a more recent interim balance sheet than the fiscal year end behind the income statement above; the latest one is used deliberately, because the bridge is struck against today's share price`
            : `as of the fiscal year end ${cashSrc.period}`),
      'source'
    );
  } else if (secExtract.cashAndEquivalents !== null) {
    log.add(
      'Cash and equivalents',
      fmtMoney(secExtract.cashAndEquivalents, currency),
      'no cash line resolved on the balance sheet, so the summary page\'s combined cash-and-investments figure was used; it may include short-term investments',
      'estimated'
    );
  } else {
    log.add(
      'Cash and equivalents',
      fmtMoney(0, currency),
      'no cash balance could be read from any source. Excess cash is therefore zero and the equity value is understated by whatever cash the company actually holds — enter it manually to correct this.',
      'estimated'
    );
    estimatedFields.push('cashAndEquivalents (not found; treated as zero)');
  }

  if (facts?.totalDebt !== null && facts?.totalDebt !== undefined) {
    log.add('Reported financing debt', fmtMoney(facts.totalDebt, currency), 'latest balance-sheet total debt', 'source');
  } else if (secExtract.totalDebt !== null) {
    log.add('Reported financing debt', fmtMoney(secExtract.totalDebt, currency), 'summary-page total debt used because the detailed balance-sheet key did not resolve', 'estimated');
  } else {
    log.add('Reported financing debt', fmtMoney(0, currency), 'no debt balance resolved from either source; zero is a missing-data fallback, not a confirmed debt-free balance sheet', 'estimated');
    estimatedFields.push('totalDebt (not found; treated as zero)');
  }

  // 3. Fill remaining market-data gaps from fundamentals and user overrides;
  //    market cap derives as price x shares when not provided directly.
  const ovBody = (body.financialOverrides ?? {}) as Partial<Financials>;
  if (quote.price === null && typeof ovBody.sharePrice === 'number') quote.price = ovBody.sharePrice;
  if (quote.sharesOutstanding === null) {
    quote.sharesOutstanding =
      secExtract.sharesOutstanding ?? (typeof ovBody.sharesOutstanding === 'number' ? ovBody.sharesOutstanding : null);
  }
  if (quote.marketCap === null && quote.price !== null && quote.sharesOutstanding !== null) {
    quote.marketCap = quote.price * quote.sharesOutstanding;
  }

  const sovereign = await fetchGovernmentBondYield(cls?.suffix ?? 'US');
  if (sovereign.rate === null) estimatedFields.push(`riskFreeRate (${market.name} 10-year unavailable)`);
  // The old US-yield-plus-spread rule survives only as a disclosed outage
  // fallback. The normal path uses the country's sovereign yield directly.
  const fallbackUs = sovereign.rate === null ? await fetchGovernmentBondYield('US') : null;
  const riskFreeRate = sovereign.rate ?? localRiskFreeRate(fallbackUs?.rate ?? DEFAULT_RISK_FREE_RATE, market);
  log.add(
    `${market.name} 10-year government bond`,
    fmtPct(riskFreeRate),
    sovereign.rate === null
      ? `${market.name} sovereign series unavailable; temporary US Treasury plus disclosed market-spread fallback used.`
      : `FRED series ${sovereign.series}, sourced from the OECD long-term 10-year benchmark yield. This is the risk-free rate used in the valuation.`,
    sovereign.rate === null ? 'estimated' : 'source'
  );

  // 4. Resolve each valuation input: reorganized balance sheet first, then the
  //    overview extract, then a documented estimate. Nothing is silently guessed.
  const revenue = reorg?.revenue ?? secExtract.revenue;
  const ebit = reorg?.ebit ?? secExtract.ebit;

  let investedCapital = reorg?.investedCapital ?? secExtract.investedCapital;
  const investedCapitalOverridden = (body.financialOverrides as any)?.investedCapital !== undefined;
  if (investedCapital === null && ebit !== null && !investedCapitalOverridden) {
    // Last resort only: the balance sheet did not yield net PP&E or working
    // capital, so infer the capital base from NOPAT at an assumed ROIC.
    const t = reorg?.operatingTaxRate ?? secExtract.effectiveTaxRate ?? 0.23;
    investedCapital = (ebit * (1 - t)) / FALLBACK_ROIC;
    estimatedFields.push(`investedCapital (inferred at ${FALLBACK_ROIC * 100}% ROIC)`);
    log.add(
      'Invested capital',
      fmtMoney(investedCapital, currency),
      `balance-sheet build failed, so inferred from NOPAT at an assumed ${FALLBACK_ROIC * 100}% ROIC`,
      'estimated'
    );
  }

  // A bank or insurer is valued with the Part 5 equity model, which needs an
  // entirely different set of inputs: net income and book equity, not revenue,
  // EBIT and invested capital. Demanding the industrial fields of a bank sends
  // every bank to the manual-entry form for figures it does not report at all,
  // so the required set is chosen by filer type here rather than downstream.
  const isFinancial = reorg?.isFinancial ?? false;
  const bookEquity =
    facts?.totalEquity == null ? null : facts.totalEquity - (facts.minorityInterest ?? 0);

  const missingCritical: string[] = [];
  if (isFinancial) {
    if (facts?.netIncome == null) missingCritical.push('netIncome');
    if (bookEquity === null) missingCritical.push('bookEquity');
    if (quote.price === null) missingCritical.push('sharePrice');
    if (quote.sharesOutstanding === null) missingCritical.push('sharesOutstanding');
  } else {
    if (revenue === null) missingCritical.push('revenue');
    if (ebit === null) missingCritical.push('ebit');
    if (investedCapital === null) missingCritical.push('investedCapital');
    if (quote.price === null) missingCritical.push('sharePrice');
    if (quote.marketCap === null) missingCritical.push('marketCap');
    if (quote.sharesOutstanding === null) missingCritical.push('sharesOutstanding');
  }

  const hasOverridesForAll = missingCritical.every(
    (f) => body.financialOverrides && (body.financialOverrides as any)[f] !== undefined
  );

  if (missingCritical.length > 0 && !hasOverridesForAll) {
    return NextResponse.json(
      {
        needsManualInput: true,
        companyName: companyTitle,
        ticker,
        missingFields: missingCritical,
        partial: { ...secExtract, ...quote },
        message: isFinancial
          ? // Name only what is actually missing. Saying "net income and common
            // book equity" when book equity read fine sends the reader hunting
            // for a figure the model already has.
            `${companyTitle} looks like a bank or insurer, so it is valued with the equity cash flow model rather than an enterprise DCF. ${
              missingCritical.length === 1
                ? `One input for that model could not be read from the source: ${HUMAN_FIELD[missingCritical[0]] ?? missingCritical[0]}.`
                : `These inputs could not be read from the source: ${missingCritical.map((f) => HUMAN_FIELD[f] ?? f).join(', ')}.`
            } Enter them from the latest annual report, in ${currency}.`
          : isInternational
            ? `Some figures could not be fetched automatically for this non-US listing${quote.price !== null ? ` (latest price ${quote.price} was fetched)` : ''}. Enter the missing figures from the company's latest annual report, in ${currency} to match the reported financials.`
            : 'Some fields required for the DCF could not be found automatically (free data sources have gaps, especially for non-standard filers). Please supply them manually and resubmit.',
      },
      { status: 200 }
    );
  }

  const taxRate = reorg?.operatingTaxRate ?? secExtract.effectiveTaxRate;
  if (taxRate === null) estimatedFields.push('taxRate (23% default)');
  const da = reorg?.depreciationAmortization ?? secExtract.depreciationAmortization;
  if (da === null) estimatedFields.push('depreciationAmortization');
  const capex = reorg?.capex ?? secExtract.capex;
  if (capex === null) estimatedFields.push('capex');
  const changeInNWC = reorg?.changeInNWC ?? secExtract.changeInNWC;
  if (changeInNWC === null) estimatedFields.push('changeInNWC');

  const totalDebt = reorg?.totalDebt ?? secExtract.totalDebt ?? 0;
  const cash = facts?.cash ?? secExtract.cashAndEquivalents ?? 0;

  // Beta (Ch. 15). No return history is wired up, so this relevers a market
  // anchor at the company's own capital structure rather than assuming 1.0.
  const betaEstimate = estimateBeta({
    rawRegressionBeta: quote.beta,
    marketCap: quote.marketCap,
    debtIncludingEquivalents: totalDebt + (reorg?.debtEquivalents ?? 0),
    // A bank's leverage is operating, not financial, so it must not be relevered
    // through: doing so would clamp beta at its ceiling and put the cost of
    // equity near 18% -- and that is the one rate the equity model hangs on.
    isFinancial,
  });
  const beta = betaEstimate.beta;
  if (betaEstimate.confidence === 'estimated') {
    estimatedFields.push(isFinancial ? 'beta (market beta, not relevered)' : 'beta (relevered market beta)');
  }

  // A bank clears the gate above without revenue, EBIT or invested capital,
  // because the equity model needs none of them. They are zeroed rather than
  // cast from null so that no NaN reaches the enterprise engine, whose output
  // is suppressed for a financial anyway; the one number the equity model takes
  // from it, the cost of equity, is CAPM and depends only on the risk-free
  // rate, beta and the premia.
  const financials: Financials = {
    ticker,
    companyName: companyTitle,
    fiscalYearEnd: secExtract.fiscalYearEnd,
    currency,
    marketName: market.name,

    revenue: revenue ?? 0,
    ebit: ebit ?? 0,
    effectiveTaxRate: taxRate ?? 0.23,

    depreciationAmortization: da ?? 0,
    capex: capex ?? 0,
    changeInNWC: changeInNWC ?? 0,

    investedCapital: investedCapital ?? 0,
    totalDebt,
    cashAndEquivalents: cash,
    minorityInterest: reorg?.minorityInterest ?? secExtract.minorityInterest ?? 0,

    operatingCash: reorg?.operatingCash ?? cash,
    excessCash: reorg?.excessCash ?? 0,
    nonoperatingAssets: reorg?.nonoperatingAssets ?? 0,
    debtEquivalents: reorg?.debtEquivalents ?? 0,

    revenueCagr3y: secExtract.revenueCagr3y,

    sharePrice: quote.price as number,
    sharesOutstanding: quote.sharesOutstanding as number,
    marketCap: quote.marketCap ?? 0,
    beta,

    isFinancial,
    estimatedFields,
    ...body.financialOverrides,
  };

  // 5. Cost of capital (Ch. 13): the pre-tax cost of debt comes from the actual
  //    interest burden where the two line items are consistent.
  const debtIncludingEquivalents = financials.totalDebt + financials.debtEquivalents;
  const debtToCapital =
    financials.marketCap + debtIncludingEquivalents > 0
      ? debtIncludingEquivalents / (financials.marketCap + debtIncludingEquivalents)
      : 0;
  const cod = costOfDebt(
    facts?.interestExpense ?? secExtract.interestExpense,
    debtIncludingEquivalents > 0 ? debtIncludingEquivalents : null,
    riskFreeRate,
    debtToCapital
  );
  log.add(
    'Pre-tax cost of debt',
    fmtPct(cod.rate),
    cod.basis === 'interest burden'
      ? 'interest expense divided by total debt, the best free-data proxy for yield to maturity (Ch. 13)'
      : 'no usable interest expense; risk-free rate plus a leverage-scaled credit spread',
    cod.basis === 'interest burden' ? 'derived' : 'estimated'
  );

  // 6. Assumptions: seed defaults from the market and the fetched data, then
  //    apply any user overrides. Terminal RONIC defaults to the WACC (Ch. 12).
  const draftAssumptions = defaultAssumptions(financials, {
    riskFreeRate,
    equityRiskPremium: market.equityRiskPremium,
    countryRiskPremium: market.countryRiskPremium,
    preTaxCostOfDebt: cod.rate,
  });
  const draftForWacc: DcfAssumptions = { ...draftAssumptions, ...body.assumptionOverrides };
  const { wacc } = calculateWacc(financials, draftForWacc);

  const assumptions: DcfAssumptions = {
    ...draftForWacc,
    terminalIncrementalRoic:
      body.assumptionOverrides?.terminalIncrementalRoic !== undefined ? draftForWacc.terminalIncrementalRoic : wacc,
  };

  const result = runDcf(financials, assumptions);
  result.costOfDebtBasis = cod.basis;

  const reorganization: Reorganization =
    reorg?.reorganization ?? {
      investedCapitalBuild: [],
      nonoperatingAssetsBuild: [],
      debtEquivalentsBuild: [],
      adjustments: [],
    };

  if (facts !== null && facts.unresolved.length > 0) {
    log.add(
      'Unresolved source fields',
      facts.unresolved.join(', '),
      'these line items were not present in the source payload, so any adjustment that needed them was skipped',
      'estimated'
    );
  }

  // 7. Part 5: a bank or insurer cannot be valued with an enterprise DCF, so
  //    the equity cash flow model runs instead and the UI shows it in place of
  //    the enterprise output. Everything it needs -- net income, book equity,
  //    the cost of equity -- is already computed above.
  let equityValuation: EquityDcfResult | null = null;
  if (financials.isFinancial) {
    // Same two figures the gate above checked for, plus whatever the user typed
    // into the manual form when the source could not supply them.
    const ov = body.financialOverrides as any;
    const netIncome = ov?.netIncome ?? facts?.netIncome ?? null;
    const equityBase = ov?.bookEquity ?? bookEquity;
    const missing: string[] = [];
    if (equityBase === null) missing.push('book equity');
    if (netIncome === null) missing.push('net income');
    if (!(financials.sharesOutstanding > 0)) missing.push('shares outstanding');

    if (missing.length === 0) {
      equityValuation = equityDcf({
        netIncome: netIncome as number,
        bookEquity: equityBase as number,
        costOfEquity: result.costOfEquity,
        growth: assumptions.stage1RevenueGrowth,
        terminalGrowth: assumptions.terminalGrowth,
        explicitYears: assumptions.explicitYears,
        sharesOutstanding: financials.sharesOutstanding,
        sharePrice: financials.sharePrice,
        currency,
      });
      log.add(
        'Common book equity',
        fmtMoney(equityBase as number, currency),
        'total equity less minority interest; the capital base the equity model grows and earns on (Part 5)',
        'source'
      );
      log.add(
        'Return on equity',
        fmtPct(equityValuation.returnOnEquity),
        'latest net income over common book equity; the equity model\'s equivalent of ROIC',
        'derived'
      );
      const equilibriumAssumed =
        equityValuation.terminalReturnOnEquity <= equityValuation.costOfEquity + 1e-9;
      log.add(
        'Terminal return on equity',
        fmtPct(equityValuation.terminalReturnOnEquity),
        equilibriumAssumed
          ? `set to the ${fmtPct(equityValuation.costOfEquity)} cost of equity, because the current return is not a usable basis for a perpetuity — this is the competitive-equilibrium assumption the enterprise model makes for RONIC (Ch. 12), and it leaves value above book equity coming only from the excess returns of the explicit years`
          : `the bank's current return, assumed to persist. It is the largest assumption in the valuation: continuing value is the bulk of the answer and this rate drives it. The competitive-equilibrium alternative — fading to the ${fmtPct(equityValuation.costOfEquity)} cost of equity, as the enterprise model does for industrials — is quoted in the warnings above`,
        equilibriumAssumed ? 'default' : 'estimated'
      );
    } else {
      log.add(
        'Equity cash flow model',
        'not computable',
        `this filer needs the Part 5 equity model rather than an enterprise DCF, but ${missing.join(' and ')} could not be read from the source, so it could not be run`,
        'estimated'
      );
      estimatedFields.push(`equity model unavailable (missing ${missing.join(', ')})`);
    }
  }

  const dataQuality = appendDerivedRows(log, financials, assumptions, facts, result.wacc, betaEstimate, {
    basis: sovereign.rate === null
      ? `${market.name} sovereign yield was unavailable; temporary US Treasury plus market-spread fallback (Ch. 13)`
      : `${market.name} 10-year government bond yield from FRED/OECD series ${sovereign.series}; same-currency rate used to discount the cash flows (Ch. 13)`,
    confidence: sovereign.rate === null ? 'estimated' : 'source',
  });

  return NextResponse.json({ financials, assumptions, result, reorganization, dataQuality, equityValuation });
}
