import { NextRequest, NextResponse } from 'next/server';
import { fetchCompanyFacts, resolveTickerToCik, screenRecommendationHistory } from '@/lib/secEdgar';
import { POST as valueTicker } from '@/app/api/valuation/route';

export const maxDuration = 60;

const CANDIDATES = [
  ['JPM', 'Financials'], ['AXP', 'Financials'], ['SPGI', 'Financials'], ['CME', 'Financials'],
  ['JNJ', 'Pharmaceuticals'], ['MRK', 'Pharmaceuticals'], ['LLY', 'Pharmaceuticals'],
  ['AMGN', 'Biotechnology'], ['GILD', 'Biotechnology'], ['ABBV', 'Biotechnology'],
  ['MSFT', 'Software'], ['ADP', 'Business services'], ['V', 'Payments'], ['MA', 'Payments'],
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

export async function GET() {
  const settled = await Promise.all(CANDIDATES.map(([ticker, industry]) => inspect(ticker, industry)));
  const recommendations = settled
    .map((result) => result.item)
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.discountToFairValue - a.discountToFairValue)
    .slice(0, 10);
  return NextResponse.json(
    {
      asOf: new Date().toISOString(),
      universeSize: CANDIDATES.length,
      sourceFailures: settled.filter((result) => result.status === 'source-error').length,
      methodology: 'High-ROIC-sector candidate screen; not an exhaustive market-wide scan.',
      recommendations,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
  );
}
