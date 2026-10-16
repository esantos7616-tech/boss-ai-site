// Free, keyless market data so the team works from real numbers instead of
// remembered (and often made-up) ones. Yahoo Finance chart API first, Stooq
// as a fallback. All stats are computed here, not by an LLM.
const NAMES = {
  apple: 'AAPL', microsoft: 'MSFT', nvidia: 'NVDA', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL',
  meta: 'META', facebook: 'META', tesla: 'TSLA', netflix: 'NFLX', amd: 'AMD', intel: 'INTC',
  berkshire: 'BRK-B', 'jp morgan': 'JPM', jpmorgan: 'JPM', visa: 'V', mastercard: 'MA', walmart: 'WMT',
  costco: 'COST', disney: 'DIS', coca: 'KO', pepsi: 'PEP', mcdonald: 'MCD', nike: 'NKE', starbucks: 'SBUX',
  palantir: 'PLTR', broadcom: 'AVGO', oracle: 'ORCL', salesforce: 'CRM', adobe: 'ADBE', paypal: 'PYPL',
  shopify: 'SHOP', uber: 'UBER', coinbase: 'COIN', 'exxon': 'XOM', chevron: 'CVX', boeing: 'BA',
  's&p 500': 'SPY', 's&p': 'SPY', nasdaq: 'QQQ', 'dow jones': 'DIA', bitcoin: 'BTC-USD', ethereum: 'ETH-USD',
};

const STOP = new Set(('I A AI CEO CFO CTO COO IPO USA US UK EU GDP LLC INC API OK FAQ ROI EPS PE DCF YOY QOQ ATH IRA HSA SEC FED CPI PPI USD EUR ' +
  'THE AND FOR BUY SELL HOLD YES NO AM PM ASAP FYI DIY B2B B2C LOL IMO TLDR NFT DM PR HR IT TV PC OR IS IN ON AT TO MY ME DO BE IF SO UP ' +
  'AN AS BY OF WE GO HI MVP SEO SAAS APP IOS KPI CRM ESG TA FA DD YTD MTD ETF ETFS RSI MACD SMA EMA LLM LLMS GPT ROTH PDF CSV URL ' +
  'VS ALL ANY NEW NOW HOW WHY WHO WHAT WHEN TOP BEST LOW HIGH NOT BUT CAN GET PUT CALL MAX MIN USE ONE TWO TEN').split(/\s+/));

export function extractTickers(text, max = 4) {
  const out = [];
  const add = (t) => { if (t && !out.includes(t) && out.length < max) out.push(t); };
  for (const m of text.matchAll(/\$([A-Za-z]{1,5}(?:[.-][A-Za-z]{1,2})?)\b/g)) add(m[1].toUpperCase());
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) if (!STOP.has(m[1])) add(m[1]);
  const lower = text.toLowerCase();
  for (const [name, t] of Object.entries(NAMES)) if (new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(lower)) add(t);
  return out;
}

const cache = new Map();
const TTL = 5 * 60_000;

async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 BossAI' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('yahoo ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter((x) => typeof x === 'number');
  if (closes.length < 2) throw new Error('yahoo: no data');
  return { closes, price: r.meta?.regularMarketPrice ?? closes.at(-1), currency: r.meta?.currency || 'USD',
    name: r.meta?.longName || r.meta?.shortName || sym, source: 'Yahoo Finance' };
}

async function fromStooq(sym) {
  const s = sym.includes('-USD') ? sym.replace('-USD', 'usd').toLowerCase() : sym.toLowerCase().replace('-', '.') + '.us';
  const res = await fetch(`https://stooq.com/q/d/l/?s=${s}&i=d`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('stooq ' + res.status);
  const rows = (await res.text()).trim().split('\n').slice(1).map((l) => Number(l.split(',')[4])).filter(Number.isFinite);
  const closes = rows.slice(-252);
  if (closes.length < 2) throw new Error('stooq: no data');
  return { closes, price: closes.at(-1), currency: 'USD', name: sym, source: 'Stooq' };
}

export function computeStats(closes, price) {
  const last = price ?? closes.at(-1);
  const ret = (n) => (closes.length > n ? (last / closes[closes.length - 1 - n] - 1) * 100 : null);
  const sma = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const logs = [];
  for (let i = 1; i < closes.length; i++) logs.push(Math.log(closes[i] / closes[i - 1]));
  const mean = logs.reduce((a, b) => a + b, 0) / (logs.length || 1);
  const vol = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logs.length - 1)) * Math.sqrt(252) * 100;
  let peak = closes[0], maxDd = 0;
  for (const c of closes) { peak = Math.max(peak, c); maxDd = Math.min(maxDd, c / peak - 1); }
  return {
    price: last, chg1d: ret(1), chg1m: ret(21), chg6m: ret(126), chg1y: ret(Math.min(251, closes.length - 1)),
    high52: Math.max(...closes), low52: Math.min(...closes), sma50: sma(50), sma200: sma(200),
    volatility: vol, maxDrawdown: maxDd * 100,
  };
}

export async function quote(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let raw;
  try { raw = await fromYahoo(sym); } catch { raw = await fromStooq(sym); }
  const value = { symbol: sym, name: raw.name, currency: raw.currency, source: raw.source, asOf: new Date().toISOString(),
    ...computeStats(raw.closes, raw.price) };
  cache.set(sym, { at: Date.now(), value });
  return value;
}

const f = (n, d = 2) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d));
const pct = (n) => (n == null ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%');

export function formatQuote(q) {
  const trend = q.sma50 && q.sma200 ? (q.sma50 > q.sma200 ? 'above' : 'below') : null;
  return `${q.symbol} (${q.name}) - ${q.currency} ${f(q.price)} | 1d ${pct(q.chg1d)}, 1m ${pct(q.chg1m)}, 6m ${pct(q.chg6m)}, 1y ${pct(q.chg1y)} | ` +
    `52w range ${f(q.low52)}-${f(q.high52)} | SMA50 ${f(q.sma50)}, SMA200 ${f(q.sma200)}${trend ? ` (50-day is ${trend} 200-day)` : ''} | ` +
    `annualized volatility ${f(q.volatility, 0)}%, max drawdown over the past year ${f(q.maxDrawdown, 0)}% [source: ${q.source}, fetched ${q.asOf}]`;
}

export async function contextFor(symbols) {
  if (!symbols.length || process.env.MARKET_DATA === '0') return { symbols: [], text: '' };
  const results = await Promise.allSettled(symbols.map(quote));
  const lines = [], ok = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { lines.push(formatQuote(r.value)); ok.push(symbols[i]); }
    else lines.push(`${symbols[i]}: live data unavailable. Do NOT state any price or statistic for ${symbols[i]}.`);
  });
  return { symbols: ok, text: 'VERIFIED MARKET DATA (the only numbers you may cite as current):\n' + lines.join('\n') };
}
