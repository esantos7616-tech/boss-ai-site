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

test('empty team: the supervisor hires specialists from scratch', async () => {
  process.env.STARTER_AGENTS = '0';
  mockFetch((b) => {
    const sys = b.messages[0].content;
    if (sys.includes(PLAN)) {
      assert.match(sys, /Your team is EMPTY/);
      return JSON.stringify({ intent: 'business', needs_team: true, agents: [], new_agents: [
        { name: 'Lawn Care Advisor', mission: 'You help people start local service businesses like lawn care.', tags: ['lawn', 'service'] },
        { name: 'Pricing Coach', mission: 'You set prices for small service businesses using real costs.', tags: ['pricing'] },
      ] });
    }
    if (isAgent(b)) return 'Charge per lawn, not per hour.\nCONFIDENCE: 0.7';
    return 'Start with 5 neighbors.\n---META---\n{"consensus":"medium"}';
  });
  const out = await orchestrator.handle('How do I start a lawn care business?');
  assert.deepEqual(out.meta.spawned, ['Lawn Care Advisor', 'Pricing Coach']);
  assert.deepEqual(out.meta.team.map((t) => t.agent).sort(), ['Lawn Care Advisor', 'Pricing Coach']);
  assert.equal(agents.list().length, 2);
});

test('empty team and an unusable plan still gets an answer from a generalist', async () => {
  process.env.STARTER_AGENTS = '0';
  mockFetch((b) => (isAgent(b) ? 'Here is a direct answer.\nCONFIDENCE: 0.5' : b.messages[0].content.includes(PLAN) ? 'no' : 'Final.'));
  const out = await orchestrator.handle('What is a P/E ratio?');
  assert.equal(out.meta.team[0].agent, 'Generalist');
});

test('web search results reach the agents and come back as sources', async () => {
  process.env.WEB_SEARCH = '1';
  let agentSawWeb = false;
  mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) return '{"intent":"general","needs_team":true,"agents":["macro"],"search":["fed rate decision"]}';
    if (isAgent(b)) {
      agentSawWeb = b.messages[1].content.includes('WEB RESULTS') && b.messages[1].content.includes('Fed holds rates');
      return 'The Fed held rates [1].\nCONFIDENCE: 0.8';
    }
    return 'The Fed held rates steady [1].\n---META---\n{"consensus":"high"}';
  }, (url) => (url.includes('duckduckgo')
    ? '<div class="result"><a class="result__a" href="https://example.com/fed">Fed holds rates</a><a class="result__snippet">Rates unchanged.</a></div>'
    : { status: 404 }));
  const out = await orchestrator.handle('What did the Fed just do?');
  assert.ok(agentSawWeb);
  assert.deepEqual(out.meta.sources, [{ n: 1, title: 'Fed holds rates', url: 'https://example.com/fed' }]);
});

test('supervisor rewrites weak agents and edits the watchlist on request', async () => {
  mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) return '{"intent":"investing","needs_team":true,"agents":["technicals","fundamentals"]}';
    if (isAgent(b)) return 'Report.\nCONFIDENCE: 0.5';
    return 'Added NVDA to your watchlist.\n---META---\n' + JSON.stringify({
      consensus: 'medium', agent_scores: { technicals: 0.2, fundamentals: 0.9 },
      improve_agents: [
        { id: 'technicals', mission: 'You read trend and momentum and ALWAYS give an invalidation level.' },
        { id: 'fundamentals', mission: 'This one scored well, so it must not be rewritten.' },
      ],
      watchlist_add: ['nvda'],
    });
  });
  const out = await orchestrator.handle('add NVDA to my watchlist and tell me about it');
  assert.deepEqual(out.meta.improved, ['Technical Analyst']);
  assert.match(agents.get('technicals').mission, /invalidation level/);
  assert.doesNotMatch(agents.get('fundamentals').mission, /must not be rewritten/);
  assert.deepEqual(out.meta.watchlist, ['NVDA']);
});

test('daily briefing runs the full team and is stored', async () => {
  const briefing = await import('../lib/briefing.js');
  const watchlist = await import('../lib/watchlist.js');
  watchlist.add(['AAPL']);
  let briefingPrompt = '';
  mockFetch((b) => {
    if (b.messages[0].content.includes(PLAN)) {
      briefingPrompt = b.messages[1].content;
      return '{"intent":"chat","needs_team":false,"direct_reply":"hi"}'; // forceTeam must ignore this
    }
    if (isAgent(b)) return 'Markets were mixed.\nCONFIDENCE: 0.6';
    return 'Market: mixed.\nWatchlist: AAPL flat.\nTask: call 3 customers.\nLearn: P/E ratio.\n---META---\n{"consensus":"medium"}';
  });
  const item = await briefing.generate();
  assert.match(briefingPrompt, /daily briefing/);
  assert.match(briefingPrompt, /AAPL/);
  assert.match(item.message, /Task: call 3 customers/);
  assert.match(item.meta.label, /^Briefing · /);
  assert.ok(item.meta.team.length >= 1);
  assert.equal(briefing.latest().id, item.id);
});
