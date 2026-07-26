// Debug endpoint: reports per-source fetch status for a ticker so data-source
// problems can be diagnosed on the live deployment without guesswork.
// Usage: /api/health?ticker=MSFT (or 600519.SS, 0700.HK, SAP.DE, ...)

import { NextRequest, NextResponse } from 'next/server';
import { resolveTickerToCik, fetchCompanyFacts, edgarStatementFacts } from '@/lib/secEdgar';
import { probeStatements, saStatementFacts, StatementFacts } from '@/lib/statements';
import { detectFinancial } from '@/lib/adjustments';
import { fetchRiskFreeRate } from '@/lib/yahooFinance';
import {
  classifyTicker,
  saResolve,
  saPrice,
  saOverview,
  eastmoneyQuote,
  twelveDataPrice,
} from '@/lib/globalData';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get('ticker') ?? 'MSFT').trim().toUpperCase();
  const cls = classifyTicker(ticker);
  const report: Record<string, unknown> = {
    ticker,
    classification: cls,
    twelveDataKeySet: Boolean(process.env.TWELVE_DATA_KEY),
    fred10y: await fetchRiskFreeRate(),
  };

  // Whether a filer is read as a bank or insurer decides which of the two
  // valuation models runs, so report the verdict and the three quantities the
  // heuristics test. A name like "JPMorgan Chase" or "HSBC Holdings" carries no
  // banking keyword, so the balance-sheet tests are what has to fire.
  const detection = (name: string, f: StatementFacts | null) =>
    f === null
      ? { ran: false }
      : {
          ran: true,
          name,
          ...detectFinancial(name, f),
          revenue: f.revenue,
          interestIncome: f.interestIncome,
          totalAssets: f.totalAssets,
          netPPE: f.netPPE,
          totalDebt: f.totalDebt,
          totalEquity: f.totalEquity,
          netIncome: f.netIncome,
        };

  try {
    if (!cls || cls.market === 'US') {
      const symbol = cls?.symbol ?? ticker;
      const resolved = await resolveTickerToCik(symbol);
      report.edgar = resolved;
      report.saPrice = await saPrice(symbol.toLowerCase());
      report.twelveDataPrice = await twelveDataPrice(symbol);
      if (resolved) {
        report.detection = detection(resolved.title, edgarStatementFacts(await fetchCompanyFacts(resolved.cik)));
      }
    } else if (cls.market === 'CN-A') {
      report.eastmoney = await eastmoneyQuote(cls.symbol, cls.suffix as string);
      const listing = await saResolve(cls.symbol, cls.exchange!);
      report.saListing = listing;
      if (listing) {
        report.saOverview = await saOverview(listing);
        report.saStatements = await probeStatements(listing);
        report.detection = detection(listing.name, await saStatementFacts(listing));
      }
    } else {
      const listing = await saResolve(cls.symbol, cls.exchange!);
      report.saListing = listing;
      if (listing) {
        report.saOverview = await saOverview(listing);
        report.saStatements = await probeStatements(listing);
        report.detection = detection(listing.name, await saStatementFacts(listing));
      }
    }
  } catch (e: any) {
    report.error = e.message;
  }

  return NextResponse.json(report);
}
