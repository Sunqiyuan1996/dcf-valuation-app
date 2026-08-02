const base = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const tickers = (process.env.LIVE_TICKERS ?? 'NVO,NOVO-B.CO').split(',').map((x) => x.trim()).filter(Boolean);

for (const ticker of tickers) {
  const health = await fetch(`${base}/api/health?ticker=${encodeURIComponent(ticker)}`);
  if (!health.ok) throw new Error(`${ticker}: health returned HTTP ${health.status}`);
  const diagnostics = await health.json();
  if (diagnostics.error) throw new Error(`${ticker}: health failed: ${diagnostics.error}`);

  const response = await fetch(`${base}/api/valuation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticker }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`${ticker}: ${result.error ?? `HTTP ${response.status}`}`);
  if (result.needsManualInput) {
    throw new Error(`${ticker}: unexpectedly needs manual input (${result.missingFields.join(', ')})`);
  }
  if (!(result.financials?.sharesOutstanding > 0) || !(result.financials?.sharePrice > 0)) {
    throw new Error(`${ticker}: invalid price/share output`);
  }
  console.log(`pass live valuation ${ticker}`);
}
