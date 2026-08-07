const base = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const response = await fetch(base);
if (!response.ok) throw new Error(`Home page returned HTTP ${response.status}`);
const html = await response.text();
for (const expected of ['VALUATION DESK', 'Ticker symbol', 'Value it', 'Daily opportunity screen']) {
  if (!html.includes(expected)) throw new Error(`Rendered page is missing: ${expected}`);
}
console.log(`pass UI HTTP smoke test (${base})`);
