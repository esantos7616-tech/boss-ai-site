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
const TTL = 60_000; // short, so "what's the price" is fresh
const UA = { 'User-Agent': 'Mozilla/5.0 BossAI' };

// Turns any company name ("rocket lab", "costco", "s&p 500", "bitcoin") into a
// real ticker using Yahoo's symbol search, so an AI never has to guess one.
const SEARCHABLE = new Set(['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY', 'MUTUALFUND', 'FUTURE', 'CURRENCY']);
export async function searchSymbol(query) {
  const key = 'search:' + query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.value;
  const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
    { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('yahoo search ' + res.status);
  const quotes = (await res.json())?.quotes || [];
  const best = quotes.find((q) => q.symbol && SEARCHABLE.has(q.quoteType)) || null;
  const value = best ? { symbol: best.symbol, name: best.longname || best.shortname || best.symbol } : null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

// hints: tickers or company names from the supervisor's plan. Returns tickers
// that were confirmed to exist (by search or by a successful quote).
export async function resolve(hints, max = 6) {
  const out = [], missing = [];
  if (process.env.MARKET_DATA === '0') return { symbols: out, missing };
  await Promise.all(hints.slice(0, max).map(async (h) => {
    const raw = String(h || '').trim();
    if (!raw) return;
    const ticker = raw.replace(/^\$/, '');
    if (/^[\^A-Za-z0-9.=-]{1,12}$/.test(ticker) && ticker === ticker.toUpperCase()) {
      try { await quote(ticker); out.push(ticker); return; } catch { /* fall through to name search */ }
    }
    try {
      const found = await searchSymbol(raw);
      if (found) { if (!out.includes(found.symbol)) out.push(found.symbol); return; }
    } catch { /* unresolvable */ }
    missing.push(raw);
  }));
  return { symbols: out, missing };
}

async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('yahoo ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const m = r?.meta || {};
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter((x) => typeof x === 'number');
  if (closes.length < 2 || typeof (m.regularMarketPrice ?? closes.at(-1)) !== 'number') throw new Error('yahoo: no data');
  return { closes, price: m.regularMarketPrice ?? closes.at(-1), currency: m.currency || 'USD',
    name: m.longName || m.shortName || sym, source: 'Yahoo Finance',
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    exchange: m.fullExchangeName || m.exchangeName || null,
    dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null };
}

async function fromStooq(sym) {
  const s = sym.includes('-USD') ? sym.replace('-USD', 'usd').toLowerCase() : sym.toLowerCase().replace('-', '.') + '.us';
  const res = await fetch(`https://stooq.com/q/d/l/?s=${s}&i=d`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('stooq ' + res.status);
  const rows = (await res.text()).trim().split('\n').slice(1).map((l) => Number(l.split(',')[4])).filter(Number.isFinite);
  const closes = rows.slice(-252);
  if (closes.length < 2) throw new Error('stooq: no data');
  return { closes, price: closes.at(-1), currency: 'USD', name: sym, source: 'Stooq (last daily close)', asOf: null };
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
    price: last, prevClose: closes.length > 1 ? closes[closes.length - 2] : null, chg1d: ret(1), chg1m: ret(21), chg6m: ret(126), chg1y: ret(Math.min(251, closes.length - 1)),
    high52: Math.max(...closes), low52: Math.min(...closes), sma50: sma(50), sma200: sma(200),
    volatility: vol, maxDrawdown: maxDd * 100,
  };
}

export async function quote(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let raw;
  try { raw = await fromYahoo(sym); } catch { raw = await fromStooq(sym); }
  const value = { symbol: sym, name: raw.name, currency: raw.currency, source: raw.source,
    asOf: raw.asOf || new Date().toISOString(), exchange: raw.exchange || null, dayHigh: raw.dayHigh ?? null, dayLow: raw.dayLow ?? null,
    ...computeStats(raw.closes, raw.price) };
  cache.set(sym, { at: Date.now(), value });
  return value;
}

const f = (n, d = 2) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d));
const pct = (n) => (n == null ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%');

export function formatQuote(q) {
  const trend = q.sma50 && q.sma200 ? (q.sma50 > q.sma200 ? 'above' : 'below') : null;
  return `${q.symbol} (${q.name}) - ${q.currency} ${f(q.price)} as of ${q.asOf} | 1d ${pct(q.chg1d)}, 1m ${pct(q.chg1m)}, 6m ${pct(q.chg6m)}, 1y ${pct(q.chg1y)} | ` +
    `52w range ${f(q.low52)}-${f(q.high52)} | SMA50 ${f(q.sma50)}, SMA200 ${f(q.sma200)}${trend ? ` (50-day is ${trend} 200-day)` : ''} | ` +
    `annualized volatility ${f(q.volatility, 0)}%, max drawdown over the past year ${f(q.maxDrawdown, 0)}% [source: ${q.source}, fetched ${q.asOf}]`;
}

export async function contextFor(symbols) {
  if (!symbols.length || process.env.MARKET_DATA === '0') return { symbols: [], quotes: [], failed: [], text: '' };
  const results = await Promise.allSettled(symbols.map(quote));
  const lines = [], ok = [], quotes = [], failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { lines.push(formatQuote(r.value)); ok.push(symbols[i]); quotes.push(r.value); }
    else { failed.push(symbols[i]); lines.push(`${symbols[i]}: live data unavailable. Do NOT state any price or statistic for ${symbols[i]}.`); }
  });
  return { symbols: ok, quotes, failed, text: 'VERIFIED MARKET DATA (the only numbers you may cite as current):\n' + lines.join('\n') };
}

// "What's the price of X?" is answered straight from the data, with no AI in
// between, so the number can't be made up or mistyped.
export function priceAnswer(quotes, failed = []) {
  const money = (n, c) => (c === 'USD' ? '$' : '') + f(n) + (c === 'USD' ? '' : ' ' + c);
  const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const blocks = quotes.map((q) => {
    const change = q.prevClose != null ? q.price - q.prevClose : null;
    const lines = [`${q.name} (${q.symbol}): ${money(q.price, q.currency)}`];
    if (change != null) lines.push(`Change: ${change >= 0 ? '+' : ''}${f(change)} (${pct(q.chg1d)}) vs previous close ${money(q.prevClose, q.currency)}`);
    if (q.dayLow != null && q.dayHigh != null) lines.push(`Day range: ${f(q.dayLow)} - ${f(q.dayHigh)}`);
    lines.push(`52-week range: ${f(q.low52)} - ${f(q.high52)}`);
    lines.push(`As of ${when(q.asOf)}${q.exchange ? ' on ' + q.exchange : ''} (${q.source})`);
    return lines.join('\n');
  });
  if (failed.length) blocks.push(`I couldn't get live data for ${failed.join(', ')} right now. Check the ticker, or try again in a minute.`);
  blocks.push('Free market data can trail the live market by a few minutes. Check your broker before placing a trade.');
  return blocks.join('\n\n');
}
