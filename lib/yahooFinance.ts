// Free, keyless macro data. Share prices and fundamentals now come from the
// sources in lib/globalData.ts; this module only supplies the risk-free rate.

/** 10-year US Treasury yield (DGS10, in percent) from FRED's free CSV endpoint. */
export async function fetchRiskFreeRate(): Promise<number | null> {
  return (await fetchGovernmentBondYield('US')).rate;
}

export interface GovernmentBondYield {
  rate: number | null;
  series: string | null;
}

/** FRED/OECD monthly 10-year benchmark yields, keyed by listing suffix. */
const TEN_YEAR_SERIES: Record<string, string> = {
  US: 'DGS10',
  DE: 'IRLTLT01DEM156N', AS: 'IRLTLT01NLM156N', PA: 'IRLTLT01FRM156N', BR: 'IRLTLT01BEM156N',
  AT: 'IRLTLT01GRM156N', VI: 'IRLTLT01ATM156N', HE: 'IRLTLT01FIM156N', IR: 'IRLTLT01IEM156N',
  MI: 'IRLTLT01ITM156N', MC: 'IRLTLT01ESM156N', LS: 'IRLTLT01PTM156N',
  UK: 'IRLTLT01GBM156N', L: 'IRLTLT01GBM156N', SW: 'IRLTLT01CHM156N',
  JP: 'IRLTLT01JPM156N', T: 'IRLTLT01JPM156N', ST: 'IRLTLT01SEM156N', CO: 'IRLTLT01DKM156N',
  OL: 'IRLTLT01NOM156N', IC: 'IRLTLT01ISM156N', TO: 'IRLTLT01CAM156N', V: 'IRLTLT01CAM156N',
  AX: 'IRLTLT01AUM156N', NZ: 'IRLTLT01NZM156N', KS: 'IRLTLT01KRM156N', KQ: 'IRLTLT01KRM156N',
  TA: 'IRLTLT01ILM156N', SS: 'IRLTLT01CNM156N', SH: 'IRLTLT01CNM156N', SZ: 'IRLTLT01CNM156N',
  WA: 'IRLTLT01PLM156N', PR: 'IRLTLT01CZM156N', BU: 'IRLTLT01HUM156N', IS: 'IRLTLT01TRM156N',
};

export async function fetchGovernmentBondYield(suffix: string | null): Promise<GovernmentBondYield> {
  const series = TEN_YEAR_SERIES[suffix ?? 'US'] ?? null;
  if (series === null) return { rate: null, series: null };
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { rate: null, series };
    const lines = (await res.text()).trim().split('\n');
    // The last rows can be "." on market holidays -- walk back to the most
    // recent numeric value.
    for (let i = lines.length - 1; i > 0; i--) {
      const value = parseFloat(lines[i].split(',')[1]);
      if (isFinite(value) && value > -5) return { rate: value / 100, series }; // 4.23 -> 0.0423
    }
    return { rate: null, series };
  } catch {
    return { rate: null, series };
  }
}
