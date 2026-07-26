// Free, keyless macro data. Share prices and fundamentals now come from the
// sources in lib/globalData.ts; this module only supplies the risk-free rate.

/** 10-year US Treasury yield (DGS10, in percent) from FRED's free CSV endpoint. */
export async function fetchRiskFreeRate(): Promise<number | null> {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const lines = (await res.text()).trim().split('\n');
    // The last rows can be "." on market holidays -- walk back to the most
    // recent numeric value.
    for (let i = lines.length - 1; i > 0; i--) {
      const value = parseFloat(lines[i].split(',')[1]);
      if (isFinite(value) && value > 0) return value / 100; // 4.23 -> 0.0423
    }
    return null;
  } catch {
    return null;
  }
}
