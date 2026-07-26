# Working brief for Claude

Read this first. It is the context that does not live in the code: the goal, the
decisions that look wrong until you know why, the environment traps, and what is
currently broken.

`README.md` is written for a human user and is **stale** — it predates the beta
estimator, the data-quality panel, and the Part 5 equity model, and it still
claims beta defaults to 1.0 and that figures always print with `$`. Trust this
file and the code over the README.

## The goal

A fair value per share for any ticker on an OECD exchange (excluding Latin
America) plus China A and H shares, with **zero manual entry**, built faithfully
on Koller, Goedhart & Wessels, *Valuation: Measuring and Managing the Value of
Companies* (McKinsey).

Two non-negotiables the user has restated repeatedly:

1. **Every estimated input must be disclosed** with the basis it was estimated
   from and a confidence tag. This runs through `QualityLog` in
   `lib/dataQuality.ts` and surfaces as the data-quality panel and a workbook
   sheet. An undisclosed assumption is a defect, not a shortcut.
2. **No silent degradation.** If an accounting adjustment cannot be applied,
   push it to `Reorganization.adjustments` with `applied: false` and a reason so
   the UI can show the gap. If the wrong security might be being valued, refuse
   with an error rather than return a number.

## Architecture

`lib/types.ts` is the contract between the fetch layer, the engine, and the UI.
Change it deliberately.

- `lib/globalData.ts` — prices and non-US fundamentals (stockanalysis.com,
  Eastmoney). `lib/yahooFinance.ts` — FRED risk-free rate.
- `lib/statements.ts` — alias-tolerant statement facts from both SA and EDGAR.
  Field lookup is case- and punctuation-insensitive via `normKey`.
- `lib/adjustments.ts` — Koller Ch. 9 and Ch. 18–22. `reorganize()` splits
  operating from excess cash, capitalizes leases and R&D, treats provisions as
  debt equivalents, normalizes the cycle, builds invested capital, and computes
  the operating tax rate. `detectFinancial()` decides enterprise vs equity model.
- `lib/costOfCapital.ts`, `lib/beta.ts` — Ch. 13 and Ch. 15.
- `lib/dcf.ts` — the enterprise engine. `lib/equityDcf.ts` — the Part 5 engine.
- `lib/workbook.ts` / `lib/equityWorkbook.ts` → `lib/xlsx.ts`, a dependency-free
  OOXML writer. Two builders, not one with branches: a bank shares almost no
  rows with an industrial.
- `app/api/valuation/route.ts` is the orchestrator. `/api/health?ticker=...`
  reports what every source returned plus a `detection` block — use it before
  guessing why a ticker failed.

## Decisions that look wrong until you know why

- **A bank's beta is never unlevered and relevered.** Its leverage is operating,
  not financial. Relevering at JPMorgan's D/E of about 8 gives a beta near 6.75,
  clamped to the 2.5 ceiling, and a cost of equity around 18% — the single rate
  the whole equity model hangs on. `estimateBeta()` takes `isFinancial` and
  returns the levered beta directly.
- **`detectFinancial` tests equity-to-assets, not debt-to-assets.** A US bank's
  deposits are not tagged as debt, so JPMorgan's tagged debt is 6.9% of assets
  and a debt-share test never fires. Equity at 7.4% of assets is what no bank can
  hide. The test is guarded by low PP&E and low goodwill so an asset-light LBO is
  not misread as a bank.
- **Equity cash flow is discounted end-of-year, not mid-year.** It also makes the
  model reconcile exactly to book value when ROE equals the cost of equity, which
  is its sharpest internal audit. The economic-profit cross-check in `dcf.ts`
  likewise builds its own end-of-year DCF to compare against, because otherwise
  the mid-year convention injects a spurious ~4% error and looks like a bug.
- **Terminal ROE defaults to the company's own ROE, not to the cost of equity.**
  Defaulting to Ke pulls continuing value toward book equity by construction, so
  every profitable bank read "overvalued" without the reader being told a bearish
  assumption had been made. The user chose this explicitly. The fallback to Ke
  survives for the cases where the current ROE is unusable: non-finite, negative
  book equity, a loss year, or ROE below terminal growth plus 0.5%, beneath which
  retention exceeds 1 and continuing value goes non-positive.
- **Sensitivity grids must inherit the terminal return, not pin it.** Pinning it
  inside the grid made the centre cell disagree with the headline value. A test
  asserts they match.
- **A bank suppresses every enterprise exhibit** rather than showing them under a
  disclaimer, and the page subtitle and Excel export both branch on
  `equityValuation` so the spreadsheet can never disagree with the screen.
- **EDGAR tag lists are searched for the freshest frame, not the first hit.**
  `bestMatch()` in `lib/secEdgar.ts` evaluates every candidate tag and keeps the
  one with the latest period end, using tag order only to break ties. This is
  what fixed "MSFT fiscal year end 2010-06-30": Microsoft moved revenue off
  `Revenues` at ASC 606, the retired tag stayed in companyfacts with fiscal-2010
  as its newest frame, and returning the first non-empty tag valued the company
  on that decade-old income statement — the wrong *figures*, not just a wrong
  label. `annualHistory()` had the identical flaw and drove the growth rate off
  the same retired tag. Do not "simplify" either back to first-hit.
- **The equity workbook's cross-sheet formulas go through the `ECF` and `COE`
  row-address constants** in `lib/equityWorkbook.ts`, keyed off
  `HEADER_ROWS = 3`. A row moving without those constants moving would still open
  and still show correct cached values, then recalculate to nonsense the moment a
  reader touched a cell. `test/engine.test.ts` asserts the addresses resolve to
  the labels they claim.

## Environment

The user runs on Windows and drives the app themselves, returning screenshots.
Nothing is verified until it has run there.

- Run everything **from `dcf-valuation-app/`**. Running from the home directory
  produces an ENOENT that looks like a code error.
- Use **`npm.cmd`**, not `npm` or `npm.ps1` — PowerShell's execution policy
  blocks the `.ps1` shim.
- **Delete `.next` before switching between `run build` and `run dev`.** A stale
  cache produces `Cannot find module './948.js'`, which is not a code bug.
- `node_modules` in the app folder is the user's real install, about 360MB. Do
  not delete it and do not commit it.
- Verification gate: `npm.cmd test`, then `npm.cmd run build`. The test script
  compiles the pure-logic modules to CommonJS via `tsconfig.test.json` and runs
  them under plain node with no test framework. `npm.cmd run build` is the only
  thing that typechecks `app/`.

**If you are running inside a Cowork sandbox:** the bash mount serves *boot-time*
content for files that existed when the sandbox started, so reads of edited files
come back stale or truncated. Trust the `Read` and `Grep` tools, never bash `cat`,
and never run `git` or `tsc` in the sandbox against this tree — you would be
reading corrupted copies. Files created after boot read fine. Writes from bash
into the mount do reach Windows. `next build` SIGBUSes there.

Deployment is Vercel, auto-redeploying from
`github.com/Sunqiyuan1996/dcf-valuation-app`. Live API behaviour can only be
tested post-deploy. Beware that web fetches are cached — identical repeat results
are suspect, so vary a query parameter.

## Open bugs

- **Excess cash reads zero for many non-US listings** and the root cause has
  never been proven. A 'Cash and equivalents' data-quality row now names the
  field, the balance-sheet date, and whether it is interim — that row is what
  will identify it. Related: `probeStatements()` and the `saStatements` block in
  `/api/health` exist for this and their output has not yet been read.
- **ICBC (601398.SS) cannot be valued automatically.** Neither Eastmoney nor
  stockanalysis.com returns statements for it. It correctly reaches the *bank*
  manual-entry form as 工商银行; that is the current best outcome, not a bug to
  fix in the engine.
- Four stockanalysis.com `__data.json` field-key shapes (cash-flow, income,
  ratios) are unverified. The code degrades to "skipped and flagged" rather than
  failing, so this is non-blocking.
- `app/page.tsx` has never had a design-system pass.

## Working style the user expects

Be concise and direct; cut words that do not change the meaning. Apply the
Karpathy guidelines: state assumptions instead of silently picking one, keep
changes surgical, prefer the simplest thing that solves the stated problem, and
define a verifiable success criterion before writing code. Do not claim anything
works until a command has been run and its output read — and on this project that
command runs on the user's Windows machine, not yours.
