import { NextRequest, NextResponse } from 'next/server';
import { fetchCompanyFacts, resolveTickerToCik, screenRecommendationHistory } from '@/lib/secEdgar';
import { POST as valueTicker } from '@/app/api/valuation/route';
import { unstable_cache } from 'next/cache';
import { latestBusinessDate } from '@/lib/businessDate';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const CANDIDATES = [
  ['JPM', 'Financials'], ['AXP', 'Financials'], ['SPGI', 'Financials'], ['CME', 'Financials'],
  ['JNJ', 'Pharmaceuticals'], ['MRK', 'Pharmaceuticals'], ['LLY', 'Pharmaceuticals'],
  ['AMGN', 'Biotechnology'], ['GILD', 'Biotechnology'], ['ABBV', 'Biotechnology'],
  ['MSFT', 'Software'], ['ADP', 'Business services'], ['V', 'Payments'], ['MA', 'Payments'],
  ['MCO', 'Financial data'], ['MSCI', 'Financial data'], ['ICE', 'Financial infrastructure'],
  ['NDAQ', 'Financial infrastructure'], ['FDS', 'Financial data'], ['AON', 'Insurance services'],
  ['MMC', 'Insurance services'], ['BMY', 'Pharmaceuticals'], ['PFE', 'Pharmaceuticals'],
  ['ABT', 'Medical technology'], ['TMO', 'Life-science tools'], ['SYK', 'Medical technology'],
  ['ORCL', 'Software'], ['ACN', 'Business services'], ['INTU', 'Software'], ['PAYX', 'Business services'],
  ['ROP', 'Industrial technology'], ['VRSK', 'Data analytics'], ['CTAS', 'Business services'],
] as const;

async function inspect(ticker: string, industry: string) {
  try {
    const resolved = await resolveTickerToCik(ticker);
    if (!resolved) return { status: 'source-error' as const, item: null };
    const facts = await fetchCompanyFacts(resolved.cik);
    const history = screenRecommendationHistory(facts);
    if (!history.publicAtLeastTenYears || !history.revenueStressPassed || !history.dividendGrowthPassed) {
      return { status: 'excluded' as const, item: null };
    }

    const request = new NextRequest('http://localhost/api/valuation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker }),
    });
    const response = await valueTicker(request);
    const valuation = await response.json();
    if (!response.ok || valuation.needsManualInput || valuation.error) return { status: 'source-error' as const, item: null };
    const equity = valuation.equityValuation;
    const fairValue = equity?.fairValuePerShare ?? valuation.result?.fairValuePerShare;
    const price = equity?.marketPrice ?? valuation.result?.marketPrice;
    if (!Number.isFinite(fairValue) || !Number.isFinite(price)) return { status: 'source-error' as const, item: null };
    if (fairValue / price - 1 <= 0.3) return { status: 'excluded' as const, item: null };

    return { status: 'qualified' as const, item: {
      ticker,
      companyName: valuation.financials.companyName,
      industry,
      currency: valuation.financials.currency,
      price,
      fairValue,
      discountToFairValue: fairValue / price - 1,
      publicYears: history.publicYears,
      stressPeriods: history.stressPeriods.map(({ period, growth }) => ({ period, growth })),
      dividendYears: history.dividendYears,
      model: equity ? 'Equity cash flow' : 'Enterprise DCF',
    } };
  } catch {
    return { status: 'source-error' as const, item: null };
  }
}

async function runScreen() {
  const settled: Awaited<ReturnType<typeof inspect>>[] = [];
  // Stay comfortably below SEC's request-rate guidance instead of bursting
  // the full universe and turning throttling into a false empty screen.
  for (let i = 0; i < CANDIDATES.length; i += 5) {
    settled.push(...await Promise.all(CANDIDATES.slice(i, i + 5).map(([ticker, industry]) => inspect(ticker, industry))));
  }
  const sourceFailures = settled.filter((result) => result.status === 'source-error').length;
  // Throwing preserves Next's last successfully cached value during a failed
  // revalidation instead of replacing Friday's recommendations with an error.
  if (sourceFailures === CANDIDATES.length) throw new Error('All recommendation sources failed');
  const recommendations = settled
    .map((result) => result.item)
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.discountToFairValue - a.discountToFairValue)
    .slice(0, 10);
  return {
    asOf: new Date().toISOString(), businessDate: latestBusinessDate(), universeSize: CANDIDATES.length,
    sourceFailures, screenUnavailable: false,
    methodology: 'High-ROIC-sector candidate screen; not an exhaustive market-wide scan.', recommendations,
  };
}

const cachedScreen = unstable_cache(runScreen, ['daily-opportunity-screen-v2'], {
  revalidate: 21600,
  tags: ['daily-opportunity-screen'],
});

export async function GET() {
  try {
    const payload = await cachedScreen();
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=172800' } });
  } catch {
    return NextResponse.json({
      asOf: new Date().toISOString(), businessDate: latestBusinessDate(), universeSize: CANDIDATES.length,
      sourceFailures: CANDIDATES.length, screenUnavailable: true, recommendations: [],
      methodology: 'No successful screen has been cached yet.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
