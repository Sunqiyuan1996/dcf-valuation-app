# Valuation Analysis — DCF Fair Value Tool

Enter any US-listed ticker and get an intrinsic fair value per share, compared
against the current market price/market cap, using the enterprise-DCF
value-driver framework from Koller, Goedhart & Wessels' *Valuation: Measuring
and Managing the Value of Companies* (McKinsey & Company).

## Methodology

- **NOPAT** = EBIT × (1 − tax rate)
- **Reinvestment rate** = growth ÷ incremental ROIC (RONIC), so **FCF** = NOPAT × (1 − reinvestment rate)
- **Two-stage forecast**: an explicit stage (default 5 years) at the company's
  current growth/ROIC, then a fade stage (default 5 years) where growth
  converges to a long-run rate (default 2.5%) and incremental ROIC converges
  toward WACC — i.e. competitive advantage erodes, which is the book's
  standard conservative fade assumption.
- **WACC** via CAPM: cost of equity = risk-free rate + beta × equity risk
  premium; blended with after-tax cost of debt by market-value weights.
- **Continuing value** via the Key Value Driver Formula:
  `CV = NOPAT_(T+1) × (1 − g / RONIC) / (WACC − g)`
- **Enterprise value** = PV(explicit + fade FCF) + PV(continuing value)
- **Equity value** = Enterprise value − net debt − minority interest
- **Fair value / share** = Equity value ÷ diluted shares outstanding

Every assumption (risk-free rate, ERP, beta, cost of debt, tax rate, growth,
fade length, terminal growth, incremental ROIC) is editable in the UI and
recalculates live.

## Data sources (free, no API key required)

- **Financial statements**: [SEC EDGAR XBRL "company facts" API](https://www.sec.gov/edgar/sec-api-documentation)
  — official, free, no key, but covers **US filers only** and depends on how
  each company tags its XBRL, so some line items occasionally can't be found
  automatically (the app will ask you to fill those in by hand when that
  happens).
- **Share price**: stockanalysis.com's quote API (works from server IPs;
  Yahoo Finance blocks datacenter traffic and Stooq has a per-IP daily quota,
  which broke both earlier versions). Optional fallback for US prices: set a
  free Twelve Data API key as the `TWELVE_DATA_KEY` environment variable.
- **China A-share quotes** (price, total shares, market cap): Eastmoney's
  push2 quote API.
- **Non-US listings**: a single stockanalysis.com "financials overview" page
  supplies the price, currency, shares outstanding, and core fundamentals
  (revenue, operating income, tax rate, debt, cash, capex). The overview does
  not include D&A, working capital, or net PP&E, so invested capital is
  estimated from NOPAT at an assumed 15% ROIC — flagged in the UI and
  editable. For Hong Kong listings the price is quoted in HKD but financials
  are reported in CNY; the app converts the price into CNY (flagged) so the
  fair-value comparison is consistent.
- **Shares outstanding** (US): SEC EDGAR cover-page data
  (`dei:EntityCommonStockSharesOutstanding`); **market cap** is derived as
  price × shares. For multi-class share structures this can understate the
  total — edit the value in the UI if needed.
- **Risk-free rate**: 10-year Treasury yield (DGS10) from FRED's free CSV
  endpoint.
- **Beta**: no keyless server-friendly source exists, so it defaults to 1.0 —
  edit it in the UI (flagged as estimated).

Because both sources are free/unofficial, treat every number as a starting
point for your own diligence, not a final answer.

## Non-US listings (automatic)

Enter the ticker with its exchange suffix — e.g. `600519.SS` (Shanghai),
`000858.SZ` (Shenzhen), `0700.HK` (Hong Kong), `SAP.DE` (Germany), `7203.JP`
(Tokyo), `HSBA.UK` (London). Price and fundamentals are fetched automatically
(Eastmoney for China A quotes, stockanalysis.com otherwise), all in the
listing's local currency. Results display with a `$` sign regardless of the
actual currency. Coverage is restricted to OECD-country exchanges
(ex Latin America) plus China A/H shares; other suffixes are rejected.

If a source misses a figure, the app falls back to asking you for just the
missing fields. The `/api/health?ticker=...` endpoint shows what each data
source returned for a ticker — useful for diagnosing gaps.

## Known limitations
- Uses the most recently filed fiscal year's income-statement/cash-flow
  figures (not blended trailing-twelve-months from quarterly filings).
- For non-US listings, D&A and change in working capital are unavailable from
  the overview source and default to 0 (flagged); invested capital is an
  assumed-ROIC estimate — review it before trusting the ROIC-driven
  reinvestment defaults.
- Invested capital is approximated as net PP&E + net working capital; it does
  not attempt the book's more elaborate treatment of goodwill, operating
  leases, or off-balance-sheet items.
- Cost of debt and reinvestment defaults are simple heuristics — review them
  for capital-intensive or highly-levered companies.

## Running locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Deploying (Vercel — recommended)

1. Push this folder to a new GitHub repository.
2. Go to https://vercel.com, sign in, click **Add New → Project**, and import
   that repository.
3. Leave all defaults (Vercel auto-detects Next.js) and click **Deploy**.
4. You'll get a live URL in a couple of minutes. No environment variables or
   API keys are required for the default (free-data) setup.

Any time you push a new commit, Vercel redeploys automatically.

## If a market-data source breaks

stockanalysis.com, Eastmoney, and FRED are free/unofficial endpoints and
could change without notice. If one starts failing, the app still works — it
asks you to type in the missing values for that lookup, and
`/api/health?ticker=...` shows which source failed. The clients live in
`lib/globalData.ts` (prices + non-US fundamentals) and `lib/yahooFinance.ts`
(FRED risk-free rate). A free Twelve Data key in the `TWELVE_DATA_KEY`
environment variable adds a US-price fallback.
