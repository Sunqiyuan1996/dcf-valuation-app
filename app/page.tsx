'use client';

import { useEffect, useState } from 'react';
import {
  Adjustment,
  Confidence,
  DataQualityRow,
  DcfAssumptions,
  DcfResult,
  Financials,
  LineItem,
  Reorganization,
} from '@/lib/types';
import { EquityDcfResult } from '@/lib/equityDcf';
import { C, count, fmtPct, fmtSignedPct, fmtX, money } from './format';
import {
  ConfidenceBar,
  EconomicProfitChart,
  RangeBar,
  RoicVsWaccChart,
  ValueBuildBar,
  ValueDriverTree,
  Waterfall,
  heatStyle,
} from './charts';
import { Headline, Panel, Tile } from './components/ui';

interface ApiSuccess {
  financials: Financials;
  assumptions: DcfAssumptions;
  result: DcfResult;
  reorganization: Reorganization;
  dataQuality: DataQualityRow[];
  /** Present only for banks and insurers, where the enterprise DCF is invalid. */
  equityValuation?: EquityDcfResult | null;
}

interface ApiNeedsInput {
  needsManualInput: true;
  companyName: string;
  ticker: string;
  missingFields: string[];
  partial: Record<string, any>;
  message: string;
}

type ApiResponse = ApiSuccess | ApiNeedsInput | { error: string };

interface Recommendation {
  ticker: string;
  companyName: string;
  industry: string;
  currency: string;
  price: number;
  fairValue: number;
  discountToFairValue: number;
  publicYears: number;
  stressPeriods: Array<{ period: string; growth: number }>;
  dividendYears: Array<{ year: number; dividendPerShare: number }>;
  model: string;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  source: 'From filing',
  derived: 'Calculated',
  estimated: 'Estimated',
  default: 'Assumption',
};

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  source: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  derived: 'bg-sky-50 text-sky-700 border-sky-200',
  estimated: 'bg-amber-50 text-amber-700 border-amber-200',
  default: 'bg-slate-100 text-slate-600 border-slate-300',
};

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  source: C.positive,
  derived: C.accent,
  estimated: C.warn,
  default: C.neutral,
};

export default function Home() {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setErrorMsg] = useState<string | null>(null);
  const [needsInput, setNeedsInput] = useState<ApiNeedsInput | null>(null);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [data, setData] = useState<ApiSuccess | null>(null);
  const [assumptionDraft, setAssumptionDraft] = useState<DcfAssumptions | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);
  const [recommendationsAsOf, setRecommendationsAsOf] = useState<string | null>(null);
  const [recommendationSourceFailures, setRecommendationSourceFailures] = useState(0);
  const [recommendationUnavailable, setRecommendationUnavailable] = useState(false);
  const [recommendationBusinessDate, setRecommendationBusinessDate] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/recommendations')
      .then((res) => res.json())
      .then((json) => {
        if (!active) return;
        setRecommendations(json.recommendations ?? []);
        setRecommendationsAsOf(json.asOf ?? null);
        setRecommendationSourceFailures(json.sourceFailures ?? 0);
        setRecommendationUnavailable(Boolean(json.screenUnavailable));
        setRecommendationBusinessDate(json.businessDate ?? null);
      })
      .catch(() => {})
      .finally(() => active && setRecommendationsLoading(false));
    return () => { active = false; };
  }, []);

  async function runValuation(overrides?: { financialOverrides?: any; assumptionOverrides?: any }) {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, ...overrides }),
      });
      const json: ApiResponse = await res.json();

      if ('error' in json) {
        setErrorMsg(json.error);
        setData(null);
        setNeedsInput(null);
      } else if ('needsManualInput' in json) {
        setNeedsInput(json);
        setData(null);
      } else {
        setData(json);
        setAssumptionDraft(json.assumptions);
        setNeedsInput(null);
      }
    } catch (e: any) {
      setErrorMsg(`Request failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  function submitManualValues() {
    const overrides: Record<string, number> = {};
    for (const [k, v] of Object.entries(manualValues)) {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) overrides[k] = n;
    }
    runValuation({ financialOverrides: overrides });
  }

  function recalculate() {
    if (!assumptionDraft) return;
    runValuation({ assumptionOverrides: assumptionDraft });
  }

  return (
    <main className="min-h-screen pb-16">
      <header className="sticky top-0 z-20 border-b border-slate-700/70 bg-ink/95 shadow-lg shadow-slate-950/10 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-3">
          <div className="mr-auto">
            <div className="flex items-center gap-2 text-sm font-semibold tracking-[0.08em] text-white">
              <span className="grid h-7 w-7 place-items-center rounded-sm border border-emerald-400/40 bg-emerald-400/10 font-serif text-emerald-300">V</span>
              VALUATION DESK
            </div>
            {/* The subtitle names the method that produced the number on screen.
                A bank is valued with the Part 5 equity model and every enterprise
                exhibit is suppressed, so claiming "Enterprise DCF" there is not a
                stale label but a false one. */}
            <div className="text-[11px] text-slate-400">
              {data?.equityValuation
                ? 'Equity cash flow valuation on the McKinsey framework (Part 5)'
                : 'Enterprise DCF on the McKinsey value-driver framework'}
            </div>
          </div>
          <label className="w-72">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.04em] text-slate-400">Ticker</span>
            <input
              aria-label="Ticker symbol"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ticker && runValuation()}
              placeholder="AAPL · NVO · NOVO-B.CO"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-accent focus:outline-none"
            />
          </label>
          <button
            onClick={() => runValuation()}
            disabled={loading || !ticker}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {loading ? 'Running…' : 'Value it'}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 pt-6">
        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {needsInput && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-5">
            <p className="mb-3 text-sm text-amber-800">{needsInput.message}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {needsInput.missingFields.map((f) => (
                <label key={f} className="text-xs text-slate-600">
                  {f}
                  <input
                    type="number"
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(e) => setManualValues((prev) => ({ ...prev, [f]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <button onClick={submitManualValues} className="mt-4 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">
              Continue with these values
            </button>
          </div>
        )}

        {!data && !needsInput && !error && (
          <>
            <MarketBrief />
            <Recommendations items={recommendations} loading={recommendationsLoading} asOf={recommendationsAsOf} businessDate={recommendationBusinessDate} unavailable={recommendationUnavailable} sourceFailures={recommendationSourceFailures} onSelect={setTicker} />
            <EmptyState loading={loading} />
          </>
        )}

        {data && assumptionDraft && (
          <Results
            data={data}
            assumptionDraft={assumptionDraft}
            setAssumptionDraft={setAssumptionDraft}
            onRecalculate={recalculate}
            loading={loading}
          />
        )}

        <footer className="mt-12 border-t border-slate-200 pt-4 text-xs text-slate-400">
          Data: SEC EDGAR (US fundamentals), stockanalysis.com (prices &amp; non-US fundamentals), Eastmoney (China A
          quotes), FRED (risk-free rate). Covers OECD-country exchanges (ex LatAm) plus China A/H shares. All sources are
          free and best-effort — verify any figure you plan to rely on. Research only, not investment advice.
        </footer>
      </div>
    </main>
  );
}

function MarketBrief() {
  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-slate-800 bg-ink text-white shadow-xl shadow-slate-900/10">
      <div className="grid gap-6 px-6 py-7 md:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300">Intrinsic value research</div>
          <h1 className="max-w-2xl font-serif text-3xl leading-tight md:text-4xl">Price is observable. Value requires a point of view.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Institutional-style DCF analysis with every source, estimate, and accounting adjustment disclosed.</p>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-700 bg-slate-700 text-xs">
          {[["Framework", "McKinsey DCF"], ["Coverage", "OECD + China A/H"], ["Models", "Enterprise / Equity"], ["Output", "Fair value / share"]].map(([a, b]) => (
            <div className="bg-slate-900/80 p-3" key={a}><div className="text-slate-500">{a}</div><div className="mt-1 font-medium text-slate-100">{b}</div></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Recommendations({ items, loading, asOf, businessDate, unavailable, sourceFailures, onSelect }: { items: Recommendation[]; loading: boolean; asOf: string | null; businessDate: string | null; unavailable: boolean; sourceFailures: number; onSelect: (ticker: string) => void }) {
  return (
    <section className="mb-5 rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div><div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Daily opportunity screen</div><h2 className="mt-1 font-serif text-xl text-slate-900">Quality compounders below intrinsic value</h2></div>
        <div className="text-right text-[11px] text-slate-400">{businessDate ? `Market data through ${businessDate}` : asOf ? `Screened ${new Date(asOf).toLocaleDateString()}` : 'Screening live data'}<br />Weekends retain Friday&apos;s screen</div>
      </div>
      {loading ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">{[1, 2, 3].map((x) => <div key={x} className="h-36 animate-pulse rounded-lg bg-slate-100" />)}</div>
      ) : items.length === 0 && unavailable ? (
        <div className="px-5 py-8 text-center text-sm text-amber-700">The daily screen is temporarily unavailable because one or more market-data sources could not be reached. No recommendation conclusion was drawn.</div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-slate-500">No candidate clears every rule today. The screen does not loosen its 30% margin-of-safety threshold to fill the list.</div>
      ) : (
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <button key={item.ticker} onClick={() => onSelect(item.ticker)} className="group rounded-lg border border-slate-200 p-4 text-left transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
              <div className="flex items-start justify-between"><div><div className="font-mono text-base font-bold text-slate-900">{item.ticker}</div><div className="mt-0.5 line-clamp-1 text-xs text-slate-500">{item.companyName}</div></div><span className="rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">+{fmtPct(item.discountToFairValue)}</span></div>
              <div className="mt-4 flex items-end justify-between"><div><div className="text-[10px] uppercase tracking-wide text-slate-400">Price / fair value</div><div className="mt-1 font-mono text-sm">{money(item.price, item.currency, false)} <span className="text-slate-300">/</span> {money(item.fairValue, item.currency, false)}</div></div><span className="text-xs text-emerald-700 opacity-0 transition group-hover:opacity-100">Analyze →</span></div>
              <div className="mt-3 border-t border-slate-100 pt-3 text-[10px] text-slate-400">{item.industry} · {item.publicYears}+ years public · {item.stressPeriods.length} stress periods passed · 5y no dividend cut</div>
            </button>
          ))}
        </div>
      )}
      <div className="border-t border-slate-100 px-5 py-3 text-[10px] leading-4 text-slate-400">Screen: revenue did not decline across at least two available stress windows (2008–09, 2014–15, 2019–20); no dividend-per-share cut in the latest five fiscal years; public 10+ years; model fair value exceeds price by more than 30%. Focused high-ROIC-sector candidate universe, not a complete global-market scan. Research only.</div>
    </section>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <h2 className="text-lg font-semibold">{loading ? 'Pulling filings…' : 'Enter a ticker to value a company'}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
        Every figure is fetched, reorganized into operating and nonoperating items, and discounted on the value-driver
        framework from Koller, Goedhart &amp; Wessels&apos; <em>Valuation</em>. Nothing is typed in by hand, and every
        input is shown with its source and how firm it is.
      </p>
      <div className="mx-auto mt-6 grid max-w-2xl grid-cols-2 gap-3 text-left text-xs text-slate-500 sm:grid-cols-4">
        {[
          ['Reorganize', 'Operating vs nonoperating, Ch. 9'],
          ['Forecast', 'Growth × ROIC drives cash flow'],
          ['Discount', 'Market-specific WACC, Ch. 13'],
          ['Bridge', 'Enterprise to per share, Ch. 14'],
        ].map(([t, s]) => (
          <div key={t} className="rounded-lg border border-slate-200 p-3">
            <div className="font-semibold text-ink">{t}</div>
            <div className="mt-1">{s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function Results({
  data,
  assumptionDraft,
  setAssumptionDraft,
  onRecalculate,
  loading,
}: {
  data: ApiSuccess;
  assumptionDraft: DcfAssumptions;
  setAssumptionDraft: (a: DcfAssumptions) => void;
  onRecalculate: () => void;
  loading: boolean;
}) {
  const { financials: f, result: r, assumptions, reorganization: reorg, dataQuality } = data;
  // For a bank or insurer the enterprise DCF is meaningless, so the equity cash
  // flow model becomes the headline and the enterprise exhibits are suppressed
  // rather than shown with a disclaimer on top of them (Koller Part 5).
  const eq = data.equityValuation ?? null;
  const headline = eq
    ? { fairValue: eq.fairValuePerShare, gap: eq.valuationGapPct, verdict: eq.verdict, price: eq.marketPrice }
    : { fairValue: r.fairValuePerShare, gap: r.valuationGapPct, verdict: r.verdict, price: r.marketPrice };
  const c = f.currency;
  const m = (n: number, compact = true) => money(n, c, compact);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('valuation');

  useEffect(() => {
    const ids = ['valuation', 'diagnostics', 'assumptions', 'data-sources'];
    const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-25% 0px -65% 0px' }
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [f.ticker]);

  const softRows = dataQuality.filter((row) => row.confidence === 'estimated' || row.confidence === 'default');
  const cashRow = dataQuality.find((row) => row.field === 'Cash and equivalents');

  // What the market is pricing in: the cell in each WACC row that lands closest
  // to the traded price, plus the interpolated crossing along the base row and
  // base column (Koller Ch. 15's "what would have to be true" reading).
  const sens = r.sensitivity;
  const baseWaccIndex = sens.waccValues.findIndex((w) => Math.abs(w - sens.baseWacc) < 1e-9);
  const baseGrowthIndex = sens.growthValues.findIndex((g) => Math.abs(g - sens.baseGrowth) < 1e-9);
  const marketCellPerRow = sens.fairValues.map((row) => {
    let best = -1;
    let bestDistance = Infinity;
    row.forEach((v, j) => {
      if (!Number.isFinite(v)) return;
      const d = Math.abs(v - r.marketPrice);
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
      }
    });
    return best;
  });
  const impliedGrowth =
    baseWaccIndex >= 0 ? crossing(sens.growthValues, sens.fairValues[baseWaccIndex], r.marketPrice) : null;
  const impliedWacc =
    baseGrowthIndex >= 0
      ? crossing(
          sens.waccValues,
          sens.fairValues.map((row) => row[baseGrowthIndex]),
          r.marketPrice
        )
      : null;
  // For a financial, the range under the headline has to come from the equity
  // model's own grid; the enterprise grid is not shown at all.
  const sensitivityValues = (eq ?? r).sensitivity.fairValues.flat().filter((v) => Number.isFinite(v));
  const scenarioValues = eq
    ? []
    : r.scenarios?.scenarios.map((s) => s.fairValuePerShare).filter((v) => Number.isFinite(v)) ?? [];

  const bands = [
    sensitivityValues.length
      ? {
          label: eq ? 'Cost of equity / growth range' : 'WACC / growth range',
          low: Math.min(...sensitivityValues),
          high: Math.max(...sensitivityValues),
          color: '#e2e8f0',
        }
      : null,
    scenarioValues.length
      ? {
          label: 'Scenario range',
          low: Math.min(...scenarioValues),
          high: Math.max(...scenarioValues),
          color: C.accentSoft,
        }
      : null,
  ].filter(Boolean) as { label: string; low: number; high: number; color: string }[];

  async function exportWorkbook() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Must match what the route names the file, or a bank downloads an
      // equity workbook labelled as an enterprise DCF.
      a.download = `${f.ticker.replace(/[^A-Za-z0-9.-]/g, '_')}_${eq ? 'equity_DCF' : 'DCF'}_valuation.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setExportError(e.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  function field(
    key: keyof DcfAssumptions,
    label: string,
    kind: 'pct' | 'num' = 'pct',
    enterpriseOnly = false
  ) {
    const raw = assumptionDraft[key];
    const numeric = typeof raw === 'number' ? raw : 0;
    const shown = kind === 'pct' ? Number((numeric * 100).toFixed(2)) : numeric;
    return (
      <label key={key} className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-slate-600">
          {enterpriseOnly && eq ? <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" /> : null}
          {label}
        </span>
        <span className="flex w-24 shrink-0 items-center rounded-md border border-slate-300 bg-white focus-within:border-accent">
          <input
            type="number"
            step={kind === 'pct' ? 0.1 : 1}
            value={Number.isFinite(shown) ? shown : ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isNaN(v)) return;
              setAssumptionDraft({ ...assumptionDraft, [key]: kind === 'pct' ? v / 100 : v });
            }}
            className="w-full rounded-md px-2 py-1.5 text-right text-sm tabular-nums focus:outline-none"
          />
          {kind === 'pct' && <span className="pr-2 text-xs text-slate-400">%</span>}
        </span>
      </label>
    );
  }

  const maxFcf = Math.max(...r.forecast.map((y) => Math.abs(y.freeCashFlow)).filter(Number.isFinite), 1);

  return (
    <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-5">
      <aside className="z-10 mb-4 overflow-x-auto rounded-xl border border-slate-200 bg-white/95 p-2 shadow-sm backdrop-blur lg:sticky lg:top-[84px] lg:mb-0 lg:overflow-visible">
        <nav aria-label="Valuation result sections" className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
          {[
            ['valuation', 'Valuation'],
            ['diagnostics', 'Diagnostics'],
            ['assumptions', 'Assumptions'],
            ['data-sources', 'Data & sources'],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition hover:bg-slate-100 hover:text-ink ${
                activeSection === id ? 'bg-ink text-white hover:bg-ink hover:text-white' : 'text-slate-600'
              }`}
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 space-y-5">
      {f.isFinancial && eq && (
        <div className="rounded-xl border-l-4 border-accent bg-sky-50 p-5 text-sm text-sky-900">
          <p className="font-semibold">Valued as a financial institution, using equity cash flow.</p>
          <p className="mt-1">
            This filer looks like a bank or insurer. For these companies debt is raw material rather than financing:
            interest paid on deposits is an operating cost, so free cash flow, invested capital and the WACC all lose
            their meaning and an enterprise DCF cannot be used. Following Koller Part 5, equity cash flow — net income
            less the retained earnings needed to grow the capital base — is discounted directly at the{' '}
            {fmtPct(eq.costOfEquity)} cost of equity. The enterprise exhibits are suppressed rather than shown with a
            disclaimer on top of them.
          </p>
        </div>
      )}

      {f.isFinancial && !eq && (
        <div className="rounded-xl border-l-4 border-negative bg-red-50 p-5 text-sm text-red-800">
          <p className="font-semibold">Enterprise DCF is not valid for this company.</p>
          <p className="mt-1">
            It looks like a bank, insurer or other financial institution. For these filers debt is raw material rather
            than financing, so free cash flow and invested capital are not meaningful and WACC cannot be separated from
            operations. The Part 5 equity cash flow model should have run instead, but the book equity, net income or
            share count it needs could not be read from the source — see the data quality panel below. Treat everything
            below as illustrative only.
          </p>
        </div>
      )}

      {/* Hero */}
      <section id="valuation" className="scroll-mt-28 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              {f.companyName} <span className="font-normal text-slate-400">{f.ticker}</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {f.marketName} · fiscal year end {f.fiscalYearEnd} · figures in {c}
            </p>
          </div>
          <Verdict verdict={headline.verdict} gap={headline.gap} />
        </div>

        <div className="grid divide-slate-100 sm:grid-cols-3 sm:divide-x">
          <Headline label="Market price" value={m(headline.price, false)} />
          <Headline
            label={eq ? 'Equity DCF fair value per share' : 'DCF fair value per share'}
            value={m(headline.fairValue, false)}
            accent
          />
          <Headline
            label="Upside to fair value"
            value={fmtSignedPct(headline.gap)}
            tone={headline.gap >= 0 ? 'good' : 'bad'}
          />
        </div>

        <div className="border-t border-slate-100 px-6 pb-4 pt-5">
          <RangeBar bands={bands} fairValue={headline.fairValue} marketPrice={headline.price} currency={c} />
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 bg-slate-50 px-6 py-3">
          <div className="min-w-[220px] flex-1">
            <ConfidenceBar
              segments={(Object.keys(CONFIDENCE_LABEL) as Confidence[]).map((k) => ({
                label: CONFIDENCE_LABEL[k],
                value: dataQuality.filter((row) => row.confidence === k).length,
                color: CONFIDENCE_COLOR[k],
              }))}
            />
            <p className="mt-1.5 text-[11px] text-slate-500">
              {softRows.length} of {dataQuality.length} inputs are estimated or assumed rather than read from a filing.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* A bank exports the Part 5 equity workbook, not the enterprise one:
                the route branches on the same equityValuation the page does, so
                the spreadsheet can never disagree with what is on screen. */}
            {exportError && <span className="text-[11px] text-negative">{exportError}</span>}
            <button
              onClick={exportWorkbook}
              disabled={exporting}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-ink transition hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {exporting
                ? 'Building workbook…'
                : eq
                  ? 'Export equity model to Excel'
                  : 'Export model to Excel'}
            </button>
          </div>
        </div>
      </section>

      <div id="diagnostics" className="h-px scroll-mt-28" aria-hidden="true" />
      {eq && <EquityModel eq={eq} currency={c} sharesOutstanding={f.sharesOutstanding} />}

      {!eq && (
        <>
      {/* At a glance */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="ROIC"
          value={fmtPct(r.economicProfit.currentRoic)}
          sub={`vs WACC ${fmtPct(r.wacc)}`}
          tone={r.economicProfit.roicSpread >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Value spread"
          value={fmtSignedPct(r.economicProfit.roicSpread)}
          sub={r.economicProfit.roicSpread >= 0 ? 'Growth creates value' : 'Growth destroys value'}
          tone={r.economicProfit.roicSpread >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Continuing value"
          value={fmtPct(r.continuingValueDiagnostics.cvShareOfEnterpriseValue, 0)}
          sub="of enterprise value"
          tone={r.continuingValueDiagnostics.cvShareOfEnterpriseValue > 0.85 ? 'warn' : undefined}
        />
        <Tile
          label="DCF EV/EBIT"
          value={fmtX(r.impliedMultiples.dcfEvToEbit)}
          sub={`market ${fmtX(r.impliedMultiples.marketEvToEbit)}`}
        />
      </section>

      {/* Value driver tree */}
      <Panel title="What drives this valuation" chapter="Ch. 2 & 8 — value-driver tree" defaultOpen>
        <ValueDriverTree
          growth={assumptionDraft.stage1RevenueGrowth}
          ronic={assumptionDraft.stage1IncrementalRoic}
          wacc={r.wacc}
          roic={r.economicProfit.currentRoic}
          reinvestmentRate={r.forecast[0]?.reinvestmentRate ?? NaN}
          enterpriseValue={r.enterpriseValue}
          equityValue={r.equityValue}
          fairValuePerShare={r.fairValuePerShare}
          currency={c}
        />
      </Panel>

      {/* Where the value sits */}
      <Panel
        title="Where the value comes from"
        chapter="Ch. 12 — continuing value"
        subtitle="The continuing value usually dominates a DCF, so its implied economics deserve a direct sanity check."
      >
        <ValueBuildBar pvExplicit={r.pvExplicitFcf} pvContinuing={r.pvContinuingValue} currency={c} />
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Enterprise value" value={m(r.enterpriseValue)} bold />
          <Stat label="Implied CV EV/EBIT" value={fmtX(r.continuingValueDiagnostics.impliedCvEbitMultiple)} />
          <Stat label="Terminal RONIC" value={fmtPct(r.continuingValueDiagnostics.terminalRoic)} />
          <Stat label="Terminal growth" value={fmtPct(r.continuingValueDiagnostics.terminalGrowth)} />
          <Stat label="Terminal reinvestment" value={fmtPct(r.continuingValueDiagnostics.terminalReinvestmentRate)} />
        </div>
        {r.continuingValueDiagnostics.warnings.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {r.continuingValueDiagnostics.warnings.map((w) => (
              <li key={w} className="rounded-md border-l-2 border-warn bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {w}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Economic profit */}
      <Panel
        title="Economic profit"
        chapter="Ch. 8 & 10 — the value creation behind the cash flow"
        subtitle="Economic profit is (ROIC − WACC) × invested capital. Invested capital plus its present value must reproduce the DCF enterprise value."
      >
        <EconomicProfitChart forecast={r.forecast} currency={c} />
        <div className="mt-4 border-t border-slate-100 pt-4">
          <RoicVsWaccChart forecast={r.forecast} wacc={r.wacc} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Opening invested capital" value={m(r.economicProfit.openingInvestedCapital)} />
          <Stat label="PV of economic profit" value={m(r.economicProfit.pvEconomicProfit)} />
          <Stat
            label="EV, economic-profit method"
            value={m(r.economicProfit.enterpriseValue)}
            sub={assumptions.midYearConvention ? 'end-of-year discounting' : undefined}
            bold
          />
          <Stat
            label="Reconciliation error vs DCF"
            value={fmtPct(r.economicProfit.reconciliationError, 3)}
            sub={assumptions.midYearConvention ? 'against the DCF on the same basis' : undefined}
            tone={Math.abs(r.economicProfit.reconciliationError) < 0.005 ? 'good' : 'bad'}
          />
        </div>
        {assumptions.midYearConvention ? (
          <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
            The identity only holds on end-of-year discounting, so both legs above are compared on that
            basis. The headline enterprise value of {m(r.enterpriseValue)} is higher because the DCF uses
            the mid-year convention, which pulls every cash flow half a year closer and is worth{' '}
            {fmtPct(Math.sqrt(1 + r.wacc) - 1)} of value. Nothing is missing between the two figures.
          </p>
        ) : null}
      </Panel>

      {/* Bridge */}
      <Panel
        title="From enterprise value to value per share"
        chapter="Ch. 14 — the bridge"
        subtitle="Enterprise value becomes equity value only after debt and debt equivalents come out and excess cash and nonoperating assets go back in."
      >
        <Waterfall rows={r.bridge.rows} currency={c} />
        <div className="mt-4 grid max-w-md grid-cols-2 gap-y-1.5 border-t border-slate-100 pt-4 text-sm">
          {r.bridge.rows.map((row, i) => (
            <BridgeRow
              key={row.label}
              label={row.label}
              value={row.value < 0 ? `(${m(Math.abs(row.value))})` : m(row.value)}
              bold={i === 0 || i === r.bridge.rows.length - 1}
            />
          ))}
          <BridgeRow label="Shares outstanding" value={count(f.sharesOutstanding)} />
          <BridgeRow label="Fair value per share" value={m(r.bridge.fairValuePerShare, false)} bold />
        </div>
        {/* Excess cash is the bridge line most often silently zero, so its
            provenance is stated here rather than only in the data-quality
            panel, which is collapsed by default. */}
        {cashRow !== undefined && (
          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-slate-500">
            <span className="font-medium text-slate-600">Cash and equivalents {cashRow.value}</span> — {cashRow.basis}
          </p>
        )}
      </Panel>

      {/* Sensitivity */}
      <Panel
        title="If the two big assumptions are wrong"
        chapter="Ch. 15 — sensitivity"
        subtitle={`Fair value per share across WACC and long-run growth. Shading is distance from the ${m(
          r.marketPrice,
          false
        )} market price; the boxed cell is the base case, and the dashed cells trace what the market is pricing in.`}
      >
        <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-500" aria-label="Sensitivity shading legend">
          <span>Cheaper</span>
          <span className="heat-legend h-2.5 w-28 rounded-full border border-slate-200" aria-hidden="true" />
          <span>Richer</span>
        </div>
        <div className="overflow-x-auto">
          <table className="sticky-first-column text-xs tabular-nums">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-400">WACC ↓ / growth →</th>
                {r.sensitivity.growthValues.map((g) => (
                  <th key={g} className="px-3 py-1 text-right font-medium text-slate-500">
                    {fmtPct(g)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.sensitivity.waccValues.map((w, i) => (
                <tr key={w}>
                  <td className="px-2 py-1 font-medium text-slate-500">{fmtPct(w)}</td>
                  {r.sensitivity.growthValues.map((g, j) => {
                    const v = r.sensitivity.fairValues[i][j];
                    const isBase =
                      Math.abs(w - r.sensitivity.baseWacc) < 1e-9 && Math.abs(g - r.sensitivity.baseGrowth) < 1e-9;
                    const isMarket = marketCellPerRow[i] === j;
                    return (
                      <td
                        key={g}
                        title={
                          isMarket
                            ? `Closest to the traded price: at a ${fmtPct(w)} WACC the market is priced as if long-run growth were about ${fmtPct(g)}.`
                            : undefined
                        }
                        style={heatStyle(v, r.marketPrice)}
                        className={`px-3 py-1.5 text-right ${isBase ? 'ring-2 ring-inset ring-ink font-semibold' : ''} ${
                          isMarket ? 'outline-dashed outline-2 -outline-offset-2 outline-slate-500' : ''
                        }`}
                      >
                        {Number.isFinite(v) ? money(v, c, false) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="text-xs font-medium text-slate-600">What the market is pricing in</p>
          <p className="mt-1 text-xs text-slate-500">
            {impliedGrowth !== null ? (
              <>
                Hold the WACC at {fmtPct(r.wacc)} and the {m(r.marketPrice, false)} share price implies long-run growth
                of about <span className="font-semibold text-ink">{fmtPct(impliedGrowth)}</span>, against the{' '}
                {fmtPct(sens.baseGrowth)} assumed here.{' '}
              </>
            ) : (
              <>
                At the base {fmtPct(r.wacc)} WACC the market price falls outside this growth range entirely, so the
                grid cannot say what growth would justify it.{' '}
              </>
            )}
            {impliedWacc !== null ? (
              <>
                Hold growth at {fmtPct(sens.baseGrowth)} instead and the same price implies a WACC of about{' '}
                <span className="font-semibold text-ink">{fmtPct(impliedWacc)}</span>.
              </>
            ) : (
              <>Holding growth at {fmtPct(sens.baseGrowth)}, no WACC in this range reproduces the traded price.</>
            )}{' '}
            Either reading is the same question from a different side: what would have to be true for today&apos;s price
            to be right.
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            Dashes are combinations where growth is too close to the WACC for the perpetuity formula to mean anything.
          </p>
        </div>
      </Panel>

      {/* Scenarios */}
      {r.scenarios && (
        <Panel title="Probability-weighted scenarios" chapter="Part 5 — high-growth companies" subtitle={r.scenarios.rationale}>
          <table className="sticky-first-column w-full min-w-[620px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-400">
                <th className="py-1.5 pr-3 font-medium">Scenario</th>
                <th className="py-1.5 pr-3 font-medium">Probability</th>
                <th className="py-1.5 pr-3 font-medium">Stage 1 growth</th>
                <th className="py-1.5 pr-3 font-medium">Stage 1 RONIC</th>
                <th className="py-1.5 text-right font-medium">Fair value / share</th>
              </tr>
            </thead>
            <tbody>
              {r.scenarios.scenarios.map((s) => (
                <tr key={s.name} className="border-b border-slate-100 tabular-nums">
                  <td className="py-1.5 pr-3">{s.name}</td>
                  <td className="py-1.5 pr-3">{fmtPct(s.probability, 0)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(s.stage1RevenueGrowth)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(s.stage1IncrementalRoic)}</td>
                  <td className="py-1.5 text-right">{money(s.fairValuePerShare, c, false)}</td>
                </tr>
              ))}
              <tr className="font-semibold tabular-nums">
                <td className="py-1.5 pr-3" colSpan={4}>
                  Probability-weighted fair value per share
                </td>
                <td className="py-1.5 text-right text-accent">{money(r.scenarios.weightedFairValuePerShare, c, false)}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      )}
        </>
      )}

      {/* Assumptions */}
      <div id="assumptions" className="scroll-mt-28">
      <Panel
        title="Tune the assumptions"
        chapter="Ch. 11 & 13"
        subtitle={
          eq
            ? 'The equity model uses the cost of equity, growth, long-run growth and the explicit horizon. The RONIC and cost of debt fields below drive the enterprise engine only and do not affect the numbers above.'
            : 'Everything below feeds the numbers above. Percentages are entered as percentages.'
        }
        badge={eq ? `Cost of equity ${fmtPct(eq.costOfEquity)}` : `WACC ${fmtPct(r.wacc)}`}
      >
        <div className="grid divide-y divide-slate-100 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <section className="pb-5 lg:pr-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-slate-400">Cost of capital</h4>
              <span className="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium tabular-nums text-slate-600">
                {eq ? `Ke ${fmtPct(eq.costOfEquity)}` : `WACC ${fmtPct(r.wacc)}`}
              </span>
            </div>
            <div className="space-y-3">
              {field('riskFreeRate', 'Risk-free rate')}
              {field('equityRiskPremium', 'Equity risk premium')}
              {field('countryRiskPremium', 'Country risk premium')}
              {field('beta', 'Beta', 'num')}
              {field('preTaxCostOfDebt', 'Pre-tax cost of debt', 'pct', true)}
            </div>
            <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
              Cost of equity {fmtPct(r.costOfEquity)} · after-tax debt {fmtPct(r.afterTaxCostOfDebt)}
            </p>
          </section>
          <section className="py-5 lg:px-5 lg:py-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-slate-400">Growth & returns</h4>
              <span className="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium tabular-nums text-slate-600">
                g {fmtPct(assumptionDraft.stage1RevenueGrowth)}
              </span>
            </div>
            <div className="space-y-3">
              {field('stage1RevenueGrowth', 'Stage 1 revenue growth')}
              {field('terminalGrowth', 'Long-run growth')}
              {field('stage1IncrementalRoic', 'Stage 1 RONIC', 'pct', true)}
              {field('terminalIncrementalRoic', 'Terminal RONIC', 'pct', true)}
              {field('taxRate', 'Operating tax rate')}
            </div>
            <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
              Long-run growth {fmtPct(assumptionDraft.terminalGrowth)} · terminal return {fmtPct(assumptionDraft.terminalIncrementalRoic)}
            </p>
          </section>
          <section className="pt-5 lg:pl-5 lg:pt-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-slate-400">Horizon</h4>
              <span className="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium tabular-nums text-slate-600">
                {assumptionDraft.explicitYears + assumptionDraft.fadeYears} years
              </span>
            </div>
            <div className="space-y-3">
              {field('explicitYears', 'Explicit years', 'num')}
              {field('fadeYears', 'Fade years', 'num')}
            </div>
            {eq ? (
              <p className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" /> Enterprise-model only
              </p>
            ) : null}
          </section>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
          <span className="text-[11px] text-slate-500">
            Weights {fmtPct(r.weightOfEquity, 0)} equity / {fmtPct(r.weightOfDebt, 0)} debt
            {r.costOfDebtBasis ? ` · ${r.costOfDebtBasis}` : ''}
          </span>
          <button
            onClick={onRecalculate}
            disabled={loading}
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-40"
          >
            {loading ? 'Recalculating…' : 'Recalculate'}
          </button>
        </div>
      </Panel>
      </div>

      {!eq && (
        <>
      {/* Forecast */}
      <Panel title="Forecast detail" chapter="Ch. 11" subtitle="Explicit period, then a fade to the long-run assumptions.">
        <div className="overflow-x-auto">
          <table className="sticky-first-column w-full min-w-[880px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-400">
                {['Year', 'Revenue', 'Growth', 'EBIT margin', 'NOPAT', 'Inv. capital', 'ROIC', 'Econ. profit', 'Reinvest.', 'FCF', 'PV(FCF)'].map(
                  (h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {r.forecast.map((y) => (
                <tr key={y.year} className="border-b border-slate-100 tabular-nums">
                  <td className="py-1.5 pr-3 font-medium">{y.year}</td>
                  <td className="py-1.5 pr-3">{m(y.revenue)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(y.growth)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(y.ebitMargin)}</td>
                  <td className="py-1.5 pr-3">{m(y.nopat)}</td>
                  <td className="py-1.5 pr-3">{m(y.investedCapital)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(y.roic)}</td>
                  <td className={`py-1.5 pr-3 ${y.economicProfit < 0 ? 'text-negative' : ''}`}>{m(y.economicProfit)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(y.reinvestmentRate)}</td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <span>{m(y.freeCashFlow)}</span>
                      <span
                        className="h-1.5 rounded-sm bg-accent/60"
                        style={{ width: `${(Math.abs(y.freeCashFlow) / maxFcf) * 44}px` }}
                      />
                    </div>
                  </td>
                  <td className="py-1.5 pr-3">{m(y.presentValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Multiples */}
      <Panel
        title="Implied multiples versus the market"
        chapter="Ch. 16"
        subtitle="Multiples are a cross-check on the DCF, not a substitute. Both sides use the same NOPAT basis."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <MultipleCompare
            label="EV / EBIT"
            dcf={r.impliedMultiples.dcfEvToEbit}
            market={r.impliedMultiples.marketEvToEbit}
          />
          <MultipleCompare label="P / E on NOPAT" dcf={r.impliedMultiples.dcfImpliedPe} market={r.impliedMultiples.marketPe} />
        </div>
        <p className="mt-4 text-xs text-slate-500">DCF implied EV/revenue {fmtX(r.impliedMultiples.dcfEvToRevenue)}.</p>
      </Panel>
        </>
      )}

      {/* Data quality */}
      <div id="data-sources" className="scroll-mt-28">
      <Panel
        title="Data quality"
        chapter="Every input, with its source"
        subtitle="Anything marked Estimated or Assumption was not read from a filing. Those are the ones to challenge first."
        badge={`${softRows.length} soft of ${dataQuality.length}`}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {(Object.keys(CONFIDENCE_LABEL) as Confidence[]).map((k) => (
            <span key={k} className={`rounded-full border px-2 py-0.5 text-[11px] ${CONFIDENCE_STYLE[k]}`}>
              {CONFIDENCE_LABEL[k]} · {dataQuality.filter((row) => row.confidence === k).length}
            </span>
          ))}
        </div>
        {/* Fixed layout with declared widths. Under the browser's automatic
            algorithm the basis strings -- some of them a full sentence -- lost the
            column-width negotiation to the short nowrap value column, so Basis
            wrapped to a sliver and the Confidence badge was pushed past the right
            edge of the panel. */}
        <div className="overflow-x-auto">
        <table className="sticky-first-column w-full min-w-[760px] table-fixed text-xs">
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[56%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-400">
              <th className="py-1.5 pr-3 font-medium">Input</th>
              <th className="py-1.5 pr-3 font-medium">Value used</th>
              <th className="py-1.5 pr-3 font-medium">Basis</th>
              <th className="py-1.5 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {dataQuality.map((row) => (
              <tr key={row.field} className="border-b border-slate-100 align-top">
                <td className="py-1.5 pr-3 text-slate-700">{row.field}</td>
                <td className="py-1.5 pr-3 font-medium tabular-nums">{row.value}</td>
                <td className="py-1.5 pr-3 text-slate-500">{row.basis}</td>
                <td className="py-1.5">
                  <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] ${CONFIDENCE_STYLE[row.confidence]}`}>
                    {CONFIDENCE_LABEL[row.confidence]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Panel>
      </div>

      {!eq && (
        <>
      {/* Reorganized statements */}
      <Panel
        title="Reorganized statements"
        chapter="Ch. 9 and Part 3"
        subtitle="How the reported balance sheet was split into invested capital, nonoperating assets and debt equivalents before anything was discounted."
      >
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Build title="Invested capital" items={reorg.investedCapitalBuild} currency={c} />
          <Build title="Nonoperating assets" items={reorg.nonoperatingAssetsBuild} currency={c} />
          <Build title="Financing debt" items={[{ label: 'Reported borrowings and leases', value: f.totalDebt, note: 'deducted in the equity bridge' }]} currency={c} />
          <Build title="Debt equivalents" items={reorg.debtEquivalentsBuild} currency={c} />
        </div>
      </Panel>

      <Panel
        title="Total funds invested reconciliation"
        chapter="Ch. 9"
        subtitle="The operating and financing views should describe the same capital. A visible gap means source fields or classifications remain unresolved."
      >
        <div className="grid gap-6 p-1 sm:grid-cols-2">
          <Build title="Funds invested" items={[
            { label: 'Invested capital', value: f.investedCapital },
            { label: 'Excess cash and marketable securities', value: f.excessCash },
            { label: 'Other nonoperating assets', value: f.nonoperatingAssets },
          ]} currency={c} />
          <Build title="Financing" items={reorg.financingBuild} currency={c} />
        </div>
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3">
          <Stat label="Total funds invested" value={m(reorg.totalFundsInvested)} bold />
          <Stat label="Financing identified" value={reorg.financingTotal === null ? 'Incomplete' : m(reorg.financingTotal)} />
          <Stat label="Reconciliation gap" value={reorg.financingReconciliationGap === null ? 'Unresolved' : m(reorg.financingReconciliationGap)} tone={reorg.financingReconciliationGap !== null && Math.abs(reorg.financingReconciliationGap) <= Math.max(reorg.totalFundsInvested * 0.01, 1) ? 'good' : 'bad'} />
        </div>
      </Panel>

      <Panel
        title="Historical free cash flow reconstruction"
        chapter="Ch. 9"
        subtitle="NOPAT plus noncash operating expenses, less each observable investment in invested capital. Missing components remain unresolved rather than becoming zero."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <Build title="Free cash flow" items={reorg.historicalFcfBuild} currency={c} />
          <Build title="Cash available to investors" items={reorg.investorFlowBuild} currency={c} />
        </div>
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3">
          <Stat label="Historical FCF" value={reorg.historicalFreeCashFlow === null ? 'Incomplete' : m(reorg.historicalFreeCashFlow)} bold />
          <Stat label="Investor-flow reconciliation" value={reorg.investorFlowTotal === null ? 'Incomplete' : m(reorg.investorFlowTotal)} />
          <Stat label="Cash-flow reconciliation gap" value={reorg.investorFlowReconciliationGap === null ? 'Unresolved' : m(reorg.investorFlowReconciliationGap)} tone={reorg.investorFlowReconciliationGap !== null && Math.abs(reorg.investorFlowReconciliationGap) <= Math.max(Math.abs(reorg.historicalFreeCashFlow ?? 0) * 0.01, 1) ? 'good' : 'bad'} />
        </div>
      </Panel>

      {/* Adjustments */}
      <Panel
        title="Accounting adjustments"
        chapter="Part 3"
        subtitle="Each adjustment, whether it was applied, and — when it was not — which disclosure was missing."
        badge={`${reorg.adjustments.filter((a) => a.applied).length}/${reorg.adjustments.length} applied`}
      >
        <ul className="space-y-2">
          {reorg.adjustments.map((a) => (
            <AdjustmentRow key={a.label} a={a} currency={c} />
          ))}
        </ul>
      </Panel>
        </>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equity cash flow model (Koller Part 5) — shown instead of the enterprise
// exhibits when the filer is a bank or insurer.
// ---------------------------------------------------------------------------

function EquityModel({
  eq,
  currency,
  sharesOutstanding,
}: {
  eq: EquityDcfResult;
  currency: string;
  sharesOutstanding: number;
}) {
  const m = (n: number, compact = true) => money(n, currency, compact);
  const spread = eq.returnOnEquity - eq.costOfEquity;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Return on equity"
          value={fmtPct(eq.returnOnEquity)}
          sub={`vs cost of equity ${fmtPct(eq.costOfEquity)}`}
          tone={spread >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Value spread"
          value={fmtSignedPct(spread)}
          sub={spread >= 0 ? 'Growth creates value' : 'Growth destroys value'}
          tone={spread >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Implied price / book"
          value={fmtX(eq.impliedPriceToBook)}
          sub={`market ${fmtX(eq.marketPriceToBook)}`}
        />
        <Tile
          label="Continuing value"
          value={
            Number.isFinite(eq.pvContinuingValue / eq.equityValue)
              ? fmtPct(eq.pvContinuingValue / eq.equityValue, 0)
              : '—'
          }
          sub="of equity value"
          tone={eq.pvContinuingValue / eq.equityValue > 0.85 ? 'warn' : undefined}
        />
      </section>

      {eq.warnings.length > 0 && (
        <ul className="space-y-1.5">
          {eq.warnings.map((w) => (
            <li key={w} className="rounded-md border-l-2 border-warn bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {w}
            </li>
          ))}
        </ul>
      )}

      <Panel
        title="Equity cash flow"
        chapter="Part 5 — valuing banks"
        subtitle="A bank's growth is constrained by regulatory capital: to grow the balance sheet by g, book equity has to grow by g too. What is left of net income after that reinvestment is what shareholders can actually take out, and it is discounted at the cost of equity rather than the WACC. There is no bridge, because there is no enterprise value to bridge from."
        defaultOpen
      >
        <div className="overflow-x-auto">
          <table className="sticky-first-column w-full min-w-[720px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-400">
                {[
                  'Year',
                  'Opening book equity',
                  'Net income',
                  'ROE',
                  'Equity investment',
                  'Equity cash flow',
                  'Discount factor',
                  'PV',
                ].map((h) => (
                  <th key={h} className="py-1.5 pr-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {eq.forecast.map((y) => (
                <tr key={y.year} className="border-b border-slate-100 tabular-nums">
                  <td className="py-1.5 pr-3 font-medium">{y.year}</td>
                  <td className="py-1.5 pr-3">{m(y.openingEquity)}</td>
                  <td className="py-1.5 pr-3">{m(y.netIncome)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(y.returnOnEquity)}</td>
                  <td className="py-1.5 pr-3 text-slate-500">({m(y.equityInvestment)})</td>
                  <td className={`py-1.5 pr-3 font-medium ${y.equityCashFlow < 0 ? 'text-negative' : ''}`}>
                    {m(y.equityCashFlow)}
                  </td>
                  <td className="py-1.5 pr-3 text-slate-500">{y.discountFactor.toFixed(3)}</td>
                  <td className="py-1.5 pr-3">{m(y.presentValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 border-t border-slate-100 pt-5">
          <ValueBuildBar pvExplicit={eq.pvExplicitEquityCashFlow} pvContinuing={eq.pvContinuingValue} currency={currency} />
        </div>

        <div className="mt-5 grid max-w-md grid-cols-2 gap-y-1.5 border-t border-slate-100 pt-4 text-sm">
          <BridgeRow label="PV of explicit equity cash flow" value={m(eq.pvExplicitEquityCashFlow)} />
          <BridgeRow label="Continuing value (undiscounted)" value={m(eq.continuingValue)} />
          <BridgeRow label="PV of continuing value" value={m(eq.pvContinuingValue)} />
          <BridgeRow label="Equity value" value={m(eq.equityValue)} bold />
          <BridgeRow label="Shares outstanding" value={count(sharesOutstanding)} />
          <BridgeRow label="Fair value per share" value={m(eq.fairValuePerShare, false)} bold />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-4">
          <Stat label="Cost of equity" value={fmtPct(eq.costOfEquity)} />
          <Stat label="Growth in the capital base" value={fmtPct(eq.growth)} />
          <Stat label="Long-run growth" value={fmtPct(eq.terminalGrowth)} />
          <Stat label="Terminal ROE" value={fmtPct(eq.terminalReturnOnEquity)} />
        </div>

        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-slate-500">
          Continuing value uses the key value driver formula in its equity form, NI(t+1) × (1 − g / ROE) ÷ (Ke − g); the
          reinvestment rate g/ROE is the same identity as the enterprise model&apos;s g/RONIC. Terminal ROE is set to the{' '}
          {fmtPct(eq.costOfEquity)} cost of equity, the competitive-equilibrium assumption Ch. 12 makes when it sets
          terminal RONIC equal to the WACC. That has a consequence worth knowing: when ROE equals the cost of equity the
          model returns book equity exactly, so every unit of value above book here comes from the excess returns
          forecast during the explicit years. Discounting is end-of-year rather than mid-year, because equity cash flow
          is dominated by dividends and capital actions that fall at period ends — and because it makes that book-value
          identity hold exactly, which is a useful audit.
        </p>
      </Panel>

      <Panel
        title="If the two big assumptions are wrong"
        chapter="Ch. 15 — sensitivity"
        subtitle={`Fair value per share across the cost of equity and long-run growth. Shading is distance from the ${money(
          eq.marketPrice,
          currency,
          false
        )} market price; the boxed cell is the base case.`}
      >
        <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-500" aria-label="Sensitivity shading legend">
          <span>Cheaper</span>
          <span className="heat-legend h-2.5 w-28 rounded-full border border-slate-200" aria-hidden="true" />
          <span>Richer</span>
        </div>
        <div className="overflow-x-auto">
          <table className="sticky-first-column text-xs tabular-nums">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-400">Cost of equity ↓ / growth →</th>
                {eq.sensitivity.growthValues.map((g) => (
                  <th key={g} className="px-3 py-1 text-right font-medium text-slate-500">
                    {fmtPct(g)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {eq.sensitivity.waccValues.map((w, i) => (
                <tr key={w}>
                  <td className="px-2 py-1 font-medium text-slate-500">{fmtPct(w)}</td>
                  {eq.sensitivity.growthValues.map((g, j) => {
                    const v = eq.sensitivity.fairValues[i][j];
                    const isBase =
                      Math.abs(w - eq.sensitivity.baseWacc) < 1e-9 && Math.abs(g - eq.sensitivity.baseGrowth) < 1e-9;
                    return (
                      <td
                        key={g}
                        style={heatStyle(v, eq.marketPrice)}
                        className={`px-3 py-1.5 text-right ${isBase ? 'ring-2 ring-inset ring-ink font-semibold' : ''}`}
                      >
                        {Number.isFinite(v) ? money(v, currency, false) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function MultipleCompare({ label, dcf, market }: { label: string; dcf: number; market: number }) {
  const max = Math.max(Number.isFinite(dcf) ? dcf : 0, Number.isFinite(market) ? market : 0, 0.001);
  const bar = (v: number, color: string) => (
    <div className="h-4 rounded-sm" style={{ width: `${(Math.max(v, 0) / max) * 100}%`, backgroundColor: color }} />
  );
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="text-xs font-medium text-slate-600">{label}</div>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-3">
          <span className="w-16 text-[11px] text-slate-400">DCF</span>
          <div className="flex-1">{bar(dcf, C.accent)}</div>
          <span className="w-12 text-right text-xs tabular-nums">{fmtX(dcf)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-16 text-[11px] text-slate-400">Market</span>
          <div className="flex-1">{bar(market, C.neutral)}</div>
          <span className="w-12 text-right text-xs tabular-nums">{fmtX(market)}</span>
        </div>
      </div>
    </div>
  );
}

function Build({ title, items, currency }: { title: string; items: LineItem[]; currency: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">Nothing identified in the source data.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((it) => (
            <li key={it.label} className="text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">{it.label}</span>
                <span className="whitespace-nowrap font-medium tabular-nums">{money(it.value, currency)}</span>
              </div>
              {it.note && <div className="text-[11px] text-slate-400">{it.note}</div>}
            </li>
          ))}
          <li className="flex justify-between gap-2 border-t border-slate-200 pt-1.5 text-xs font-semibold">
            <span>Total</span>
            <span className="whitespace-nowrap tabular-nums">
              {money(
                items.reduce((s, it) => s + it.value, 0),
                currency
              )}
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}

function AdjustmentRow({ a, currency }: { a: Adjustment; currency: string }) {
  return (
    <li className={`rounded-lg border-l-2 bg-slate-50 px-3 py-2 ${a.applied ? 'border-l-positive' : 'border-l-slate-300'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-slate-700">{a.label}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-slate-400">{a.chapter}</span>
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${a.applied ? CONFIDENCE_STYLE.source : CONFIDENCE_STYLE.default}`}>
            {a.applied ? 'Applied' : 'Skipped'}
          </span>
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{a.detail}</p>
      {a.effects.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {a.effects.map((e) => (
            <li key={e.field} className="text-[11px] tabular-nums text-slate-400">
              {e.field}: {e.from === null ? 'n/a' : money(e.from, currency)} → {e.to === null ? 'n/a' : money(e.to, currency)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Verdict({ verdict, gap }: { verdict: DcfResult['verdict']; gap: number }) {
  const styles = {
    undervalued: 'bg-emerald-50 text-positive border-emerald-200',
    overvalued: 'bg-red-50 text-negative border-red-200',
    'fairly valued': 'bg-slate-100 text-slate-600 border-slate-200',
  } as const;
  const label = {
    undervalued: `${fmtPct(Math.abs(gap))} below fair value`,
    overvalued: `${fmtPct(Math.abs(gap))} above fair value`,
    'fairly valued': 'within ~7.5% of fair value',
  } as const;
  return (
    <span className={`inline-block rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${styles[verdict]}`}>
      {verdict} — {label[verdict]}
    </span>
  );
}

/**
 * Where a row or column of fair values crosses the market price, linearly
 * interpolated between the two bracketing grid points. Null when the price sits
 * outside the range the grid covers.
 */
function crossing(xs: number[], ys: number[], target: number): number | null {
  for (let i = 0; i < xs.length - 1; i++) {
    const a = ys[i];
    const b = ys[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    if ((a - target) * (b - target) <= 0) {
      return xs[i] + ((target - a) / (b - a)) * (xs[i + 1] - xs[i]);
    }
  }
  return null;
}

function Stat({
  label,
  value,
  sub,
  bold,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  bold?: boolean;
  tone?: 'good' | 'bad';
}) {
  const toneClass = tone === 'good' ? 'text-positive' : tone === 'bad' ? 'text-negative' : '';
  return (
    <div>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`tabular-nums ${bold ? 'font-semibold' : ''} ${toneClass}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div> : null}
    </div>
  );
}

function BridgeRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <div className={bold ? 'font-semibold' : 'text-slate-600'}>{label}</div>
      <div className={`text-right tabular-nums ${bold ? 'font-semibold' : ''}`}>{value}</div>
    </>
  );
}
