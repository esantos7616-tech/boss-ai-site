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
  assert.ok(agents.get('risk-manager'), 'seed agents are never retired');
});

test('thompson sampling favors proven models', () => {
  for (let i = 0; i < 30; i++) { learning.reward('models', 'good', 1); learning.reward('models', 'bad', 0); }
  let goodWins = 0;
  for (let i = 0; i < 200; i++) if (learning.sampleScore('models', 'good') > learning.sampleScore('models', 'bad')) goodWins++;
  assert.ok(goodWins > 190);
});
