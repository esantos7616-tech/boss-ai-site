import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv } from './helpers.js';

freshEnv();
const store = await import('../lib/store.js');
const { extractJson, parseReport, parseSynthesis } = await import('../lib/orchestrator.js');
const market = await import('../lib/market.js');
const registry = await import('../lib/registry.js');
const learning = await import('../lib/learning.js');
const agents = await import('../lib/agents.js');
const { QUESTIONS, grade } = await import('../lib/benchmark.js');
const { stripThinking } = await import('../lib/providers.js');
const search = await import('../lib/search.js');
const watchlist = await import('../lib/watchlist.js');
const briefing = await import('../lib/briefing.js');

beforeEach(() => { store._reset(); freshEnv(); });

test('core roster has exactly 30 unique models', () => {
  const core = registry.coreModels();
  assert.equal(core.length, 30);
  assert.equal(new Set(core.map((m) => m.id)).size, 30);
});

test('extractJson handles fences, prose and braces inside strings', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":"x}y","b":[1]}\n```'), { a: 'x}y', b: [1] });
  assert.equal(extractJson('no json here'), null);
  assert.deepEqual(extractJson('{bad} then {"ok":true}'), { ok: true });
});

test('parseReport pulls out confidence and agent suggestions', () => {
  const r = parseReport('Buy low.\nCONFIDENCE: 85\nNEW_AGENT: {"name":"Tax Helper","mission":"You explain capital gains taxes simply.","tags":["tax"]}');
  assert.equal(r.body, 'Buy low.');
  assert.equal(r.confidence, 0.85);
  assert.equal(r.suggestion.name, 'Tax Helper');
  assert.equal(parseReport('x\nNEW_AGENT: none').suggestion, null);
});

test('parseSynthesis splits answer from meta', () => {
  const s = parseSynthesis('## Answer\n**Do** this.\n--- META ---\n{"consensus":"low"}');
  assert.equal(s.answer, 'Answer\nDo this.');
  assert.equal(s.meta.consensus, 'low');
});

test('stripThinking removes reasoning blocks', () => {
  assert.equal(stripThinking('<think>hmm</think>\nAnswer'), 'Answer');
});

test('ticker extraction ignores common acronyms and maps company names', () => {
  assert.deepEqual(market.extractTickers('Should I buy $tsla or NVDA for my IRA? What about apple?'), ['TSLA', 'NVDA', 'AAPL']);
  assert.deepEqual(market.extractTickers('I want to start an LLC and an AI SaaS business ASAP'), []);
});

test('market stats are computed, not guessed', () => {
  const closes = Array.from({ length: 252 }, (_, i) => 100 + i);
  const s = market.computeStats(closes);
  assert.equal(s.price, 351);
  assert.equal(s.high52, 351);
  assert.equal(s.low52, 100);
  assert.equal(s.sma50, closes.slice(-50).reduce((a, b) => a + b) / 50);
  assert.ok(s.sma50 > s.sma200);
  assert.equal(s.maxDrawdown, 0);
});

test('supervisor = lowest measured hallucination rate once benchmarked', () => {
  process.env.GROQ_API_KEY = 'k';
  process.env.GEMINI_API_KEY = 'k';
  assert.equal(registry.pickSupervisor().id, 'gemini-2.5-flash'); // starting guess
  for (let i = 0; i < 12; i++) learning.recordHallucination('gemini-2.5-flash', i < 4);
  for (let i = 0; i < 12; i++) learning.recordHallucination('groq-llama-3.1-8b', false);
  assert.equal(registry.pickSupervisor().id, 'groq-llama-3.1-8b');
  process.env.SUPERVISOR_MODEL = 'gemini-2.0-flash';
  assert.equal(registry.pickSupervisor().id, 'gemini-2.0-flash');
});

test('benchmark grading rewards honesty on trap questions', () => {
  const einstein = QUESTIONS.find((q) => q.q.includes('Einstein'));
  assert.equal(grade(einstein, 'Einstein only won one Nobel Prize, in 1921.'), true);
  assert.equal(grade(einstein, 'He won his second Nobel Prize in 1932.'), false);
  const gold = QUESTIONS[0];
  assert.equal(grade(gold, 'Au'), true);
  assert.equal(grade(gold, 'Ag'), false);
});

test('agents: validation, dedupe, and pruning of bad spawned agents', () => {
  assert.equal(agents.spawn({ name: 'x', mission: 'short' }, {}), null);
  const a = agents.spawn({ name: 'Crypto Analyst', mission: 'You analyze crypto assets with extreme caution.', tags: ['crypto'] }, { createdBy: 'groq-qwen3-32b' });
  assert.equal(a.ownerModel, 'groq-qwen3-32b');
  assert.equal(agents.spawn({ name: 'crypto analyst', mission: 'Duplicate agent should be rejected here.' }, {}), null);
  for (let i = 0; i < 9; i++) learning.reward('agents', a.id, 0);
  assert.equal(agents.prune(), 1);
  assert.equal(agents.get(a.id), null);
  for (let i = 0; i < 9; i++) learning.reward('agents', 'risk-manager', 0);
  agents.prune();
  assert.equal(agents.get('risk-manager'), null, 'starter agents are retired like any other');
  // ...and do not come back after a restart.
  store.flush();
  store._reset();
  assert.equal(agents.get('risk-manager'), null);
  assert.ok(agents.get('market-analyst'));
});

test('agents: starters are optional and come from the editable seed file', () => {
  process.env.STARTER_AGENTS = '0';
  assert.equal(agents.list().length, 0);
  store._reset();
  delete process.env.STARTER_AGENTS;
  assert.equal(agents.list().length, 12);
});

test('agents: the supervisor can rewrite a weak agent and its record gets a fresh trial', () => {
  for (let i = 0; i < 6; i++) learning.reward('agents', 'macro', 0);
  assert.equal(agents.improve('macro', 'short', 'x'), false);
  assert.equal(agents.improve('macro', 'You explain how rates and inflation move markets, with the mechanism first.', 'sup'), true);
  assert.match(agents.get('macro').mission, /mechanism first/);
  assert.equal(agents.get('macro').history.length, 1);
  assert.equal(learning.stats('agents', 'macro').losses, 3);
});

test('thompson sampling favors proven models', () => {
  for (let i = 0; i < 30; i++) { learning.reward('models', 'good', 1); learning.reward('models', 'bad', 0); }
  let goodWins = 0;
  for (let i = 0; i < 200; i++) if (learning.sampleScore('models', 'good') > learning.sampleScore('models', 'bad')) goodWins++;
  assert.ok(goodWins > 190);
});

test('web search: parses DuckDuckGo HTML results and unwraps redirect links', () => {
  const html = `<div class="result results_links web-result"><div class="links_main">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; Co <b>news</b></a></h2>
    <a class="result__snippet" href="x">Fed holds <b>rates</b> steady</a></div></div>
    <div class="result results_links"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
  assert.deepEqual(search.parseDuck(html), [{ title: 'Example & Co news', url: 'https://example.com/a?x=1', snippet: 'Fed holds rates steady' }]);
});

test('web search: parses Google News RSS', () => {
  const xml = '<rss><channel><item><title>Nvidia beats estimates - Reuters</title><link>https://news.google.com/x</link>' +
    '<pubDate>Tue, 20 Oct 2026 12:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item></channel></rss>';
  assert.deepEqual(search.parseRss(xml), [{ title: 'Nvidia beats estimates - Reuters', url: 'https://news.google.com/x', date: 'Tue, 20 Oct 2026 12:00:00 GMT', source: 'Reuters' }]);
});

test('watchlist: validates, dedupes and caps tickers', () => {
  assert.deepEqual(watchlist.add(['nvda', '$TSLA', 'NVDA', 'not a ticker', 'BRK-B']), ['NVDA', 'TSLA', 'BRK-B']);
  assert.deepEqual(watchlist.remove(['tsla']), ['NVDA', 'BRK-B']);
});

test('briefing: schedule respects BRIEFING_TIME and runs once a day', () => {
  process.env.BRIEFING_TIME = '07:30';
  const d = (h, m) => { const x = new Date(); x.setHours(h, m, 0, 0); return x; };
  assert.equal(briefing.isDue(d(7, 29)), false);
  assert.equal(briefing.isDue(d(7, 30)), true);
  process.env.BRIEFING_TIME = 'off';
  assert.equal(briefing.isDue(d(9, 0)), false);
});
