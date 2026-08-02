# Valuation Analysis — DCF Fair Value Tool

A Next.js valuation app for US and supported international listings. It uses the value-driver framework from Koller, Goedhart & Wessels and exposes every sourced, derived, estimated, or defaulted input in a data-quality panel and in the exported workbook.

## Models

Industrial companies use enterprise DCF: NOPAT, growth-driven reinvestment, explicit and fade periods, the key-value-driver continuing value, and an enterprise-to-equity bridge. Banks and insurers use the separate Part 5 equity cash-flow model because their debt and interest are operating inputs, not financing choices.

The beta estimator uses a raw market beta when available. Otherwise it starts from a market unlevered-beta anchor and relevers it using the company's market-value capital structure. Financial institutions use the levered market beta directly and are never unlevered/relevered.

## Data and disclosure

- US filers: SEC EDGAR company facts, with StockAnalysis fallback for incomplete foreign-private-issuer/IFRS data.
- Non-US listings: StockAnalysis overview and full statement payloads.
- China A-share quotes: Eastmoney; statements fall back to StockAnalysis where available.
- Prices: StockAnalysis, with optional Twelve Data fallback when `TWELVE_DATA_KEY` is set.
- Risk-free rates: same-currency 10-year sovereign/OECD series from FRED, with a disclosed fallback.

The data-quality panel names the source and confidence of every important figure. Missing accounting adjustments are shown as skipped with a reason. Cash provenance includes the source field, balance-sheet date, and whether the observation is interim. The app never silently substitutes a different exchange listing.

Use `/api/health?ticker=...` to inspect resolution, overview fields, statement keys, cash aliases, financial-institution detection, and source failures.

## Tickers and currencies

US listings use the exchange symbol without a suffix, for example `MSFT` or Novo Nordisk's NYSE ADR `NVO`. International symbols require the supported exchange suffix, for example `NOVO-B.CO`, `SAP.DE`, `0700.HK`, `600519.SS`, or `7203.JP`.

Prices and financials are presented in the financial-statement currency. Where a listing price is quoted in another currency, the conversion is disclosed. Currency formatting uses the actual currency code/symbol rather than always displaying dollars.

ICBC (`601398.SS`) currently reaches the bank-specific manual form because neither free statement source supplies its statements. This is an explicit source-coverage limitation, not an enterprise-model fallback.

## Run and verify

```powershell
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:3000>. Before pushing a change, run:

```powershell
npm.cmd test
Remove-Item -Recurse -Force .next
npm.cmd run build
```

With the built app running, the repeatable UI and live-source checks are:

```powershell
npm.cmd run test:ui
npm.cmd run test:live
```

Set `APP_BASE_URL` to test a deployed URL and `LIVE_TICKERS` to change the comma-separated live ticker set.

## Keep two computers synchronized

GitHub `origin` is the shared source of truth. Finish work on either computer with:

```powershell
git status
git add <changed-files>
git commit -m "Describe the change"
git push origin main
```

Before starting on the other computer, first preserve or commit any local work, then run:

```powershell
git pull --rebase origin main
```

Do not edit the same uncommitted files on both computers. Vercel redeploys from the pushed GitHub branch.

## Current limitations

- Free, unofficial market-data payloads can change. Parsers accept the verified bare-array and metadata-wrapped series shapes; unknown shapes remain visible in `/api/health` and are not silently accepted.
- Some source gaps still require manual entry. Review estimated invested capital and other inferred inputs before relying on a result.
- The pure valuation and workbook tests are extensive. The production build typechecks the UI, `test:ui` checks the rendered application, and `test:live` exercises health plus automatic valuation for both Novo Nordisk listings against real sources.
