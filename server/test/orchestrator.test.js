import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, mockFetch } from './helpers.js';

freshEnv();
const store = await import('../lib/store.js');
const orchestrator = await import('../lib/orchestrator.js');
const agents = await import('../lib/agents.js');
const learning = await import('../lib/learning.js');
const registry = await import('../lib/registry.js');

beforeEach(() => {
  store._reset();
  freshEnv();
  process.env.GEMINI_API_KEY = 'test';
  process.env.GROQ_API_KEY = 'test';
});

const PLAN = 'In this step you only PLAN';
const isAgent = (b) => b.messages[0].content.includes('a specialist on the Boss AI team');
const isSynth = (b) => b.messages[0].content.includes('You are BOSS, the supervising AI');

test('no providers configured -> setup instructions', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  const out = await orchestrator.handle('hello');
  assert.equal(out.meta.setup, true);
  assert.match(out.message, /GROQ_API_KEY/);
});

test('ping does not spend any quota', async () => {
  const calls = mockFetch(() => 'x');
  const out = await orchestrator.handle('ping');
  assert.equal(out.message, 'pong');
  assert.equal(calls.length, 0);
});

test('full plan -> agents -> verify flow, with agent spawning and memory', async () => {
  const calls = mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) {
      return '```json\n{"intent":"investing","needs_team":true,"agents":["market-analyst","risk-manager"],"new_agents":[]}\n```';
    }
    if (isAgent(b)) {
      if (b.messages[0].content.includes('Market Analyst')) {
        return 'Index funds are a solid **core**.\nCONFIDENCE: 0.8\nNEW_AGENT: {"name":"Dividend Specialist","mission":"You evaluate dividend stocks for sustainable payouts.","tags":["dividend","income"]}';
      }
      return 'Keep an emergency fund first.\nCONFIDENCE: 0.9\nNEW_AGENT: none';
    }
    if (isSynth(b)) {
      return 'Start with a broad index fund and keep 3-6 months of expenses in cash.\n---META---\n{"consensus":"high","agent_scores":{"market-analyst":0.7,"risk-manager":0.9},"approve_agents":["Dividend Specialist"],"remember":["User has $2,000 to invest"]}';
    }
    throw new Error('unexpected prompt');
  });

  const out = await orchestrator.handle('I have $2000, how should I start investing?', [{ role: 'user', content: 'I have $2000, how should I start investing?' }]);
  assert.match(out.message, /index fund/);
  assert.equal(out.meta.consensus, 'high');
  assert.equal(out.meta.supervisor.id, 'gemini-2.5-flash');
  assert.equal(out.meta.team.length, 2);
  assert.deepEqual(out.meta.spawned, ['Dividend Specialist']);
  assert.equal(calls.length, 4);

  // Agents ran on worker models, never on the supervisor, and on different models.
  const workerModels = out.meta.team.map((t) => t.model);
  assert.ok(!workerModels.includes('gemini-2.5-flash'));
  assert.equal(new Set(workerModels).size, 2);

  // The spawned agent belongs to the worker model that proposed it.
  const spawned = agents.findByName('Dividend Specialist');
  assert.ok(spawned);
  assert.equal(spawned.ownerModel, out.meta.team.find((t) => t.agent === 'Market Analyst').model);
  assert.equal(spawned.approvedBy, 'gemini-2.5-flash');

  assert.deepEqual(learning.memory().facts, ['User has $2,000 to invest']);
  assert.ok(learning.stats('agents', 'risk-manager').wins > 0);

  // Feedback credits the agents, the models and the supervisor.
  const before = learning.stats('agents', 'market-analyst').losses;
  const fb = orchestrator.feedback({ interactionId: out.meta.interactionId, rating: -1, comment: 'too generic' });
  assert.equal(fb.ok, true);
  assert.equal(learning.stats('agents', 'market-analyst').losses, before + 1);
  assert.match(learning.memory().lessons[0], /too generic/);
  assert.equal(orchestrator.feedback({ interactionId: out.meta.interactionId, rating: 1 }).already, true);
});

test('small talk is answered by the supervisor alone', async () => {
  const calls = mockFetch(() => '{"intent":"chat","needs_team":false,"agents":[],"direct_reply":"Hey! What are we working on today?"}');
  const out = await orchestrator.handle('hey boss');
  assert.match(out.message, /working on/);
  assert.equal(calls.length, 1);
});

test('rate-limited supervisor fails over and gets benched', async () => {
  mockFetch((b, url) => {
    if (url.includes('generativelanguage') && b.model === 'gemini-2.5-flash') return { status: 429, text: 'slow down' };
    if (b.messages[0].content.includes(PLAN)) return '{"intent":"business","needs_team":true,"agents":["business-strategist"]}';
    if (isAgent(b)) return 'Validate with 10 customer interviews.\nCONFIDENCE: 0.7\nNEW_AGENT: none';
    return 'Talk to customers first.\n---META---\n{"consensus":"medium","agent_scores":{},"approve_agents":[],"remember":[]}';
  });
  const out = await orchestrator.handle('How do I start a lawn care business?');
  assert.notEqual(out.meta.supervisor.id, 'gemini-2.5-flash');
  assert.equal(registry.benchInfo('gemini-2.5-flash').reason, 'rate limited');
  assert.match(out.message, /customers/);
});

test('when the plan is unusable, keyword routing still picks agents', async () => {
  mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) return 'sorry I cannot do JSON';
    if (isAgent(b)) return 'Calls give you the right to buy.\nCONFIDENCE: 0.6';
    return 'Here is how options work.';
  });
  const out = await orchestrator.handle('explain options calls and puts');
  assert.ok(out.meta.team.some((t) => t.agent === 'Options Educator'));
  assert.equal(out.meta.consensus, 'unknown');
});

test('if the supervisor cannot synthesize, the best report is returned and labeled', async () => {
  let synthCalls = 0;
  mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) return '{"intent":"general","needs_team":true,"agents":["investing-coach"]}';
    if (isAgent(b)) return 'Compound interest grows money over time.\nCONFIDENCE: 0.9';
    synthCalls++;
    return { status: 500, text: 'boom' };
  });
  const out = await orchestrator.handle('what is compound interest');
  assert.ok(synthCalls >= 1);
  assert.match(out.message, /not been cross-checked/);
});
