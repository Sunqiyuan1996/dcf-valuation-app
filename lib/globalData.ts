// Free, keyless global market data for the DCF app.
//
// Sources:
//  - stockanalysis.com: US prices via its quotes API; for non-US listings a
//    single "financials overview" page payload supplies price, currency,
//    shares, and the core fundamentals (unofficial, used read-only at low
//    volume; underlying data is S&P Global Market Intelligence).
//  - Eastmoney push2 quote API: China A-share price / total shares / market
//    cap. Works from datacenter IPs.
//  - Twelve Data /price: optional US-price fallback, active only when the
//    TWELVE_DATA_KEY env var is set (free tier: 800 requests/day).
//
// Ticker coverage is restricted to OECD-country exchanges (ex Latin America)
// plus China A- and H-shares -- see EXCHANGES.

import { SecExtract } from './secEdgar';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exchange allowlist (OECD ex-LatAm + China A/H)
// ---------------------------------------------------------------------------

export interface ExchangeInfo {
  name: string;
  /** stockanalysis.com exchange path prefixes to prefer when resolving. */
  saPrefixes: string[];
  market: 'CN-A' | 'INTL';
}

export const EXCHANGES: Record<string, ExchangeInfo> = {
  SS: { name: 'Shanghai (China A)', saPrefixes: ['sha'], market: 'CN-A' },
  SH: { name: 'Shanghai (China A)', saPrefixes: ['sha'], market: 'CN-A' },
  SZ: { name: 'Shenzhen (China A)', saPrefixes: ['she', 'szse'], market: 'CN-A' },
  HK: { name: 'Hong Kong (China H)', saPrefixes: ['hkg'], market: 'INTL' },
  JP: { name: 'Tokyo', saPrefixes: ['tyo'], market: 'INTL' },
  T: { name: 'Tokyo', saPrefixes: ['tyo'], market: 'INTL' },
  DE: { name: 'Germany (XETRA/Frankfurt)', saPrefixes: ['etr', 'fra'], market: 'INTL' },
  UK: { name: 'London', saPrefixes: ['lon'], market: 'INTL' },
  L: { name: 'London', saPrefixes: ['lon'], market: 'INTL' },
  PA: { name: 'Paris', saPrefixes: ['epa'], market: 'INTL' },
  AS: { name: 'Amsterdam', saPrefixes: ['ams'], market: 'INTL' },
  BR: { name: 'Brussels', saPrefixes: ['ebr'], market: 'INTL' },
  LS: { name: 'Lisbon', saPrefixes: ['eli'], market: 'INTL' },
  MC: { name: 'Madrid', saPrefixes: ['bme'], market: 'INTL' },
  MI: { name: 'Milan', saPrefixes: ['bit'], market: 'INTL' },
  SW: { name: 'Switzerland (SIX)', saPrefixes: ['swx'], market: 'INTL' },
  VI: { name: 'Vienna', saPrefixes: ['vie'], market: 'INTL' },
  ST: { name: 'Stockholm', saPrefixes: ['sto'], market: 'INTL' },
  CO: { name: 'Copenhagen', saPrefixes: ['cph'], market: 'INTL' },
  HE: { name: 'Helsinki', saPrefixes: ['hel'], market: 'INTL' },
  OL: { name: 'Oslo', saPrefixes: ['osl'], market: 'INTL' },
  IC: { name: 'Iceland', saPrefixes: ['ice'], market: 'INTL' },
  IR: { name: 'Dublin', saPrefixes: ['dub'], market: 'INTL' },
  WA: { name: 'Warsaw', saPrefixes: ['wse'], market: 'INTL' },
  PR: { name: 'Prague', saPrefixes: ['pra'], market: 'INTL' },
  BU: { name: 'Budapest', saPrefixes: ['bdp'], market: 'INTL' },
  AT: { name: 'Athens', saPrefixes: ['ath'], market: 'INTL' },
  IS: { name: 'Istanbul', saPrefixes: ['ist'], market: 'INTL' },
  TA: { name: 'Tel Aviv', saPrefixes: ['tlv'], market: 'INTL' },
  KS: { name: 'Korea (KOSPI)', saPrefixes: ['krx'], market: 'INTL' },
  KQ: { name: 'Korea (KOSDAQ)', saPrefixes: ['kosdaq', 'krx'], market: 'INTL' },
  TO: { name: 'Toronto', saPrefixes: ['tsx'], market: 'INTL' },
  V: { name: 'TSX Venture', saPrefixes: ['tsxv'], market: 'INTL' },
  AX: { name: 'Australia (ASX)', saPrefixes: ['asx'], market: 'INTL' },
  NZ: { name: 'New Zealand', saPrefixes: ['nzx'], market: 'INTL' },
};

export const SUPPORTED_EXCHANGES_HELP =
  'Supported: US (no suffix, e.g. AAPL), China A (.SS/.SZ, e.g. 600519.SS), Hong Kong (.HK), Japan (.JP), Germany (.DE), UK (.UK/.L), France (.PA), Netherlands (.AS), Switzerland (.SW), Italy (.MI), Spain (.MC), Nordics (.ST/.CO/.HE/.OL), Canada (.TO), Australia (.AX), Korea (.KS/.KQ), and other OECD exchanges.';

export interface TickerClass {
  market: 'US' | 'CN-A' | 'INTL';
  /** Bare symbol without the exchange suffix. */
  symbol: string;
  suffix: string | null;
  exchange: ExchangeInfo | null;
}

/**
 * Classify a ticker by its exchange suffix. No suffix (or ".US") = US listing.
 * Returns null when the suffix is not a supported exchange -- but note US
 * class shares like BRK.B also land here, so callers should still try SEC
 * EDGAR before rejecting.
 */
export function classifyTicker(ticker: string): TickerClass | null {
  const m = ticker.match(/^(.+)\.([A-Z]{1,4})$/);
  if (!m) return { market: 'US', symbol: ticker, suffix: null, exchange: null };
  const [, symbol, suffix] = m;
  if (suffix === 'US') return { market: 'US', symbol, suffix, exchange: null };
  const exch = EXCHANGES[suffix];
  if (!exch) return null;
  return { market: exch.market, symbol, suffix, exchange: exch };
}

// ---------------------------------------------------------------------------
// stockanalysis.com client
// ---------------------------------------------------------------------------

export interface SaListing {
  /** URL path fragment: "msft" for US, "etr/SAP" style for international. */
  path: string;
  name: string;
  /** True when the resolved path is on the exchange the suffix asked for. */
  exchangeMatched: boolean;
  /** Every exchange prefix the search returned, for the caller's error message. */
  foundOn: string[];
}

/**
 * Resolve a bare symbol + exchange to a stockanalysis.com listing via its
 * search API. International listings come back as ids like "etr/SAP".
 *
 * A match on the requested exchange is required, and the caller is told when
 * there isn't one. The earlier version fell back to the first symbol match on
 * the theory that dual listings share their financials, and that theory is
 * wrong in the case that matters: asked for HSBC on London it returned
 * "bcba/hsbc", the Buenos Aires CEDEAR, whose price is quoted in pesos against
 * dollar financials and which carries no statements at all. A wrong exchange
 * is not a near miss -- it is a different security in a different currency, so
 * it is refused rather than valued.
 */
export async function saResolve(symbol: string, exch: ExchangeInfo): Promise<SaListing | null> {
  const data = await getJson(`https://stockanalysis.com/api/search?q=${encodeURIComponent(symbol)}`);
  const results: any[] = Array.isArray(data?.data) ? data.data : [];
  const upper = symbol.toUpperCase();
  const candidates = results.filter(
    (r) => typeof r?.s === 'string' && r.s.toUpperCase().endsWith('/' + upper)
  );
  const foundOn = Array.from(new Set(candidates.map((r) => String(r.s).split('/')[0].toLowerCase())));

  let preferred: any = null;
  for (const prefix of exch.saPrefixes) {
    preferred = candidates.find((r) => String(r.s).split('/')[0].toLowerCase() === prefix);
    if (preferred) break;
  }
  const pick = preferred ?? candidates[0] ?? null;
  if (!pick) return null;
  return {
    path: String(pick.s).toLowerCase(),
    name: typeof pick.n === 'string' ? pick.n : symbol,
    exchangeMatched: preferred !== null && preferred !== undefined,
    foundOn,
  };
}

/**
 * Latest US price from the quotes API (data.p). This endpoint only exists for
 * US listings -- international paths return an empty response (verified), so
 * non-US prices come from saOverview instead.
 */
export async function saPrice(path: string): Promise<number | null> {
  const data = await getJson(`https://stockanalysis.com/api/quotes/s/${path}`);
  const p = data?.data?.p;
  return typeof p === 'number' && isFinite(p) && p > 0 ? p : null;
}

/**
 * Decode a SvelteKit "devalue" node: a flat array where objects map keys to
 * element indices and plain arrays hold indices. Tagged values (["Date", i],
 * ["Set", ...]) are rare in this payload; only Date is resolved.
 */
export function decodeDevalueNode(values: any[]): any {
  const cache: any[] = new Array(values.length);
  const done: boolean[] = new Array(values.length).fill(false);
  const get = (i: unknown): any => {
    if (typeof i !== 'number' || i < 0 || i >= values.length) return undefined;
    if (done[i]) return cache[i];
    done[i] = true;
    const v = values[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && v.some((x) => typeof x !== 'number')) {
        cache[i] = v[0] === 'Date' ? get(v[1]) : undefined;
      } else {
        const arr: any[] = [];
        cache[i] = arr;
        for (const idx of v) arr.push(get(idx));
      }
    } else if (v && typeof v === 'object') {
      const obj: Record<string, any> = {};
      cache[i] = obj;
      for (const [k, idx] of Object.entries(v)) obj[k] = get(idx);
    } else {
      cache[i] = v;
    }
    return cache[i];
  };
  return get(0);
}

export interface SaOverview {
  /** Latest price, converted into the financial-statement currency when possible. */
  price: number | null;
  /** Currency the exchange quotes the price in (e.g. "HKD"). */
  priceCurrency: string | null;
  /** Currency the financial statements are reported in (e.g. "CNY"). */
  financialCurrency: string | null;
  /** True when price was converted via SA's own TTM PE x EPS (HK listings). */
  priceConverted: boolean;
  /** Derived as TTM net cash / net cash per share (consistent with financials). */
  sharesOutstanding: number | null;
  /** price x sharesOutstanding, in the financial-statement currency. */
  marketCap: number | null;
  fundamentals: SecExtract | null;
}

/** First finite number in an array (columns are most-recent-first). */
function firstNum(row: unknown): number | null {
  if (!Array.isArray(row)) return null;
  for (const v of row) if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * Fetch and parse a listing's "financials overview" page payload
 * ({base}/financials/__data.json). Verified structure (US, XETRA, HKG, SHA):
 *  - an "info" node: { info: { name, quote: { p, ... }, curr } } where curr is
 *    either a string or { main, price, financial };
 *  - a financials node: { statement: "overview", sections: [...] } with
 *    sections keyed by id (revenue-income, cash-debt, cash-flow-capex,
 *    margins, valuation), each carrying annual `data` arrays
 *    (most-recent-first, raw currency units) and a `ttm` object.
 * Not present in the overview: D&A, working capital, net PP&E -- those stay
 * null and are estimated/flagged downstream.
 */
export async function saOverview(listing: SaListing): Promise<SaOverview | null> {
  const base = listing.path.includes('/')
    ? `https://stockanalysis.com/quote/${listing.path}`
    : `https://stockanalysis.com/stocks/${listing.path}`;
  const payload = await getJson(`${base}/financials/__data.json?x-sveltekit-trailing-slash=1`);
  const nodes: any[] = Array.isArray(payload?.nodes) ? payload.nodes : [];

  let info: any = null;
  let fin: any = null;
  for (const node of nodes) {
    if (node?.type !== 'data' || !Array.isArray(node.data)) continue;
    const root = decodeDevalueNode(node.data);
    if (!root || typeof root !== 'object') continue;
    if (root.info && typeof root.info === 'object') info = root.info;
    if (root.statement === 'overview' && Array.isArray(root.sections)) fin = root;
  }
  if (!info && !fin) return null;

  // --- currencies + raw price ------------------------------------------------
  const curr = info?.curr;
  const priceCurrency =
    typeof curr === 'string' ? curr : typeof curr?.price === 'string' ? curr.price : null;
  const financialCurrency =
    typeof curr === 'string' ? curr : typeof curr?.financial === 'string' ? curr.financial : priceCurrency;
  const rawPrice = num(info?.quote?.p);
  const name = typeof info?.name === 'string' ? info.name : listing.name;

  // --- sections by id --------------------------------------------------------
  const sec: Record<string, any> = {};
  for (const s of fin?.sections ?? []) {
    if (s && typeof s.id === 'string') sec[s.id] = s;
  }
  const ri = sec['revenue-income'];
  const cd = sec['cash-debt'];
  const cfc = sec['cash-flow-capex'];
  const mg = sec['margins'];
  const va = sec['valuation'];

  const revenue = firstNum(ri?.data?.revenue);
  const ebit = firstNum(ri?.data?.opinc);
  const netIncome = firstNum(ri?.data?.netinccmn);
  const pretaxMargin = firstNum(mg?.data?.pretaxMargin);
  const totalDebt = firstNum(cd?.data?.debt) ?? firstNum(cd?.data?.totalDebt);
  const netCash = firstNum(cd?.data?.netcash);
  const cashAndInvestments =
    firstNum(cd?.data?.cashAndInvestments) ??
    firstNum(cd?.data?.cashAndStInvest) ??
    firstNum(cd?.data?.totalCashAndInvestments) ??
    (totalDebt !== null && netCash !== null ? totalDebt + netCash : null);
  const capex = firstNum(cfc?.data?.capex);
  const fiscalYearEnd = Array.isArray(ri?.data?.datekey) ? String(ri.data.datekey[0] ?? 'unknown') : 'unknown';

  // Effective tax rate from pretax margin: pretax income = margin x revenue.
  // (Slightly overstates the rate when minority interest is large, since
  // netinccmn excludes minorities but pretax income includes them.)
  let effectiveTaxRate: number | null = null;
  if (revenue !== null && revenue > 0 && pretaxMargin !== null && pretaxMargin > 0 && netIncome !== null) {
    const rate = 1 - netIncome / (pretaxMargin * revenue);
    if (rate > 0 && rate < 0.6) effectiveTaxRate = rate;
  }

  // Shares: TTM net cash / net cash per share is internally consistent with
  // the financial statements (SA's quote.mc is unreliable across listings).
  let sharesOutstanding: number | null = null;
  for (const src of [cd?.ttm, cd ? { netcash: firstNum(cd.data?.netcash), netcashpershare: firstNum(cd.data?.netcashpershare) } : null]) {
    const nc = num(src?.netcash);
    const ncps = num(src?.netcashpershare);
    if (nc !== null && ncps !== null && ncps !== 0) {
      const shares = nc / ncps;
      if (isFinite(shares) && shares > 0) {
        sharesOutstanding = shares;
        break;
      }
    }
  }

  // Price in financial-statement currency. When the quote currency differs
  // (e.g. HK: price HKD, financials CNY), SA's TTM PE is computed against the
  // financial currency, so PE x TTM EPS recovers the converted price.
  let price = rawPrice;
  let priceConverted = false;
  if (priceCurrency && financialCurrency && priceCurrency !== financialCurrency) {
    const pe = num(va?.ttm?.pe);
    const eps = num(ri?.ttm?.epsdil);
    if (pe !== null && pe > 0 && eps !== null && eps > 0) {
      price = pe * eps;
      priceConverted = true;
    }
  }

  const marketCap = price !== null && sharesOutstanding !== null ? price * sharesOutstanding : null;

  let revenueCagr3y: number | null = null;
  const revSeries = Array.isArray(ri?.data?.revenue)
    ? (ri.data.revenue as unknown[]).filter((v): v is number => typeof v === 'number' && isFinite(v))
    : [];
  const n = Math.min(revSeries.length - 1, 3);
  if (n >= 1 && revSeries[n] > 0) revenueCagr3y = Math.pow(revSeries[0] / revSeries[n], 1 / n) - 1;

  const missing: string[] = [];
  if (revenue === null) missing.push('revenue');
  if (ebit === null) missing.push('ebit');
  if (effectiveTaxRate === null) missing.push('effectiveTaxRate');
  missing.push('depreciationAmortization', 'changeInNWC', 'investedCapital');
  if (capex === null) missing.push('capex');

  const fundamentals: SecExtract | null = fin
    ? {
        companyName: name,
        fiscalYearEnd,
        revenue,
        ebit,
        effectiveTaxRate,
        depreciationAmortization: null,
        capex: capex === null ? null : Math.abs(capex),
        changeInNWC: null,
        investedCapital: null,
        totalDebt,
        cashAndEquivalents: cashAndInvestments,
        minorityInterest: 0,
        revenueCagr3y,
        interestExpense: null,
        sharesOutstanding,
        missing,
      }
    : null;

  return {
    price,
    priceCurrency,
    financialCurrency,
    priceConverted,
    sharesOutstanding,
    marketCap,
    fundamentals,
  };
}

// ---------------------------------------------------------------------------
// Eastmoney (China A-shares)
// ---------------------------------------------------------------------------

export interface CnQuote {
  price: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  name: string | null;
}

/**
 * China A-share quote from Eastmoney's push2 API (reachable from datacenter
 * IPs). secid prefix: 1 = Shanghai, 0 = Shenzhen. With fltt=2 the price (f43)
 * comes back as an unscaled float; f84 = total shares, f116 = total market
 * cap, f58 = company name.
 */
export async function eastmoneyQuote(symbol: string, suffix: string): Promise<CnQuote> {
  const none: CnQuote = { price: null, sharesOutstanding: null, marketCap: null, name: null };
  if (!/^\d{6}$/.test(symbol)) return none;
  const prefix = suffix === 'SZ' ? '0' : '1';
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${prefix}.${symbol}&fields=f43,f57,f58,f84,f116&fltt=2&invt=2`;
  const data = await getJson(url);
  const d = data?.data;
  if (!d) return none;
  let price = typeof d.f43 === 'number' && d.f43 > 0 ? d.f43 : null;
  const shares = typeof d.f84 === 'number' && d.f84 > 0 ? d.f84 : null;
  const marketCap = typeof d.f116 === 'number' && d.f116 > 0 ? d.f116 : null;
  // Guard against unexpected price scaling: if the quoted price disagrees
  // with marketCap/shares by more than 2x, trust the ratio.
  if (price !== null && shares !== null && marketCap !== null) {
    const implied = marketCap / shares;
    if (implied > 0 && (price / implied > 2 || implied / price > 2)) price = implied;
  }
  return { price, sharesOutstanding: shares, marketCap, name: typeof d.f58 === 'string' ? d.f58 : null };
}

// ---------------------------------------------------------------------------
// Twelve Data (optional keyed fallback)
// ---------------------------------------------------------------------------

/** US-price fallback; only active when TWELVE_DATA_KEY is set in the environment. */
export async function twelveDataPrice(symbol: string): Promise<number | null> {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) return null;
  const data = await getJson(
    `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`
  );
  const p = parseFloat(data?.price);
  return isFinite(p) && p > 0 ? p : null;
}
