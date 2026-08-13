# Valuation Desk backlog

This is the persistent feature list for ideas raised during ad-hoc product review. Items remain deliberately small and testable; implementation notes record unresolved design choices instead of turning guesses into silent behavior.

## In progress

### Accounting-framework-aware total funds invested reconciliation

- [x] Carry `us-gaap`, `ifrs`, or `unknown` through statement extraction.
- [x] Disclose the selected framework and reconciliation status in the UI and industrial workbook.
- [x] Keep incomplete financing-side schedules `unresolved`; never force the gap to zero.
- [ ] Expand framework-specific aliases and validate them against real IFRS reporters (including foreign private issuers).
- [ ] Add framework-specific review fixtures for leases, pensions, provisions, deferred taxes, hybrids, and noncontrolling interests.

## Planned

### Comparable-company analysis

- [x] Add a transparent peer-multiple engine for EV/EBIT, EV/Revenue, P/E, and price/book.
- [x] Exclude incompatible financial/industrial peers and disclose sparse peer samples.
- [x] Calculate median, quartiles, and implied enterprise/equity value ranges.
- [ ] Select a defensible peer set by industry, geography, size, and business model.
- [ ] Wire live source data and an interactive UI around the peer engine.
- Show peer dispersion, selected reference multiples, and an implied-value range beside—not inside—the DCF.
- Disclose missing or incomparable peer fields rather than dropping companies silently.

### Historical fair value versus market price

- [x] Add a dated snapshot contract with information cutoffs and look-ahead validation.
- [x] Add a sorted historical-series builder that warns on invalid or mixed-currency points.
- [ ] Store snapshots durably and expose them from saved runs/workbooks.
- Plot market price against contemporaneous model fair value, with currency and split/dividend treatment disclosed.
- Prevent look-ahead bias: a historical point may use only information available on that date.
- Decide whether snapshots are generated on demand, on a schedule, or imported from saved workbooks.

## Product principles

- Every estimate and accounting classification is disclosed with its basis.
- Unknown source shapes remain visible in diagnostics.
- A reconciliation can be complete, partial, or unresolved; unresolved is a valid result state.
- New features must preserve the separate enterprise and financial-institution models.
