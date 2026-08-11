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

- Select a defensible peer set by industry, geography, size, and business model.
- Source and normalize EV/EBIT, EV/Revenue, P/E, and price/book inputs.
- Show peer dispersion, selected reference multiples, and an implied-value range beside—not inside—the DCF.
- Disclose missing or incomparable peer fields rather than dropping companies silently.

### Historical fair value versus market price

- Store dated valuation snapshots and the information cut-off used for each snapshot.
- Plot market price against contemporaneous model fair value, with currency and split/dividend treatment disclosed.
- Prevent look-ahead bias: a historical point may use only information available on that date.
- Decide whether snapshots are generated on demand, on a schedule, or imported from saved workbooks.

## Product principles

- Every estimate and accounting classification is disclosed with its basis.
- Unknown source shapes remain visible in diagnostics.
- A reconciliation can be complete, partial, or unresolved; unresolved is a valid result state.
- New features must preserve the separate enterprise and financial-institution models.
