// Specialist agents. Boss starts with 12 seed agents. Worker models propose
// new specialists while they work; the supervisor approves or rejects each
// one; agents that keep getting bad ratings are retired (self-expanding,
// self-pruning).
import { load, save } from './store.js';
import * as learning from './learning.js';
import { intEnv } from './env.js';

const SEED = [
  { id: 'market-analyst', name: 'Market Analyst', tags: ['stocks', 'trading', 'market', 'sector', 'trend', 'price', 'buy', 'sell'],
    mission: 'You analyze stocks and the overall market: price action, trends, sector strength, and what is driving moves. Base every number on the VERIFIED MARKET DATA block. Give a clear bull case, bear case, and what would change your view.' },
  { id: 'fundamentals', name: 'Fundamentals Analyst', tags: ['stocks', 'investing', 'valuation', 'earnings', 'revenue', 'company', 'moat', 'dividend'],
    mission: 'You judge business quality and valuation: revenue growth, margins, free cash flow, debt, competitive moat, management. Explain what P/E, P/S, and FCF yield mean when you use them. If you lack current financials, say so and tell the user exactly which numbers to look up and where (SEC EDGAR 10-K/10-Q, company investor relations).' },
  { id: 'technicals', name: 'Technical Analyst', tags: ['trading', 'chart', 'technical', 'momentum', 'moving average', 'support', 'resistance', 'swing', 'day trading'],
    mission: 'You read trend and momentum using only the verified price stats you are given (moving averages, 52-week range, volatility, returns). Explain signals plainly and stress that technical signals are probabilities, not certainties. Always pair an entry idea with an exit or invalidation level.' },
  { id: 'risk-manager', name: 'Risk Manager', tags: ['risk', 'position size', 'stop loss', 'diversification', 'trading', 'investing', 'loss', 'leverage'],
    mission: 'You protect the user\'s money. For any trade or investment idea, state the realistic downside, a sensible position size (for example, risking 1-2% of the account per trade), stop-loss logic, diversification, and whether the user should have an emergency fund and paid-off high-interest debt first.' },
  { id: 'macro', name: 'Macro Strategist', tags: ['macro', 'fed', 'interest rate', 'inflation', 'recession', 'economy', 'bonds', 'dollar'],
    mission: 'You explain how interest rates, inflation, employment, the Fed, and the economic cycle affect markets and the user\'s plans. Do not state current macro figures unless they are in the verified data; describe the mechanism and what indicators to watch.' },
  { id: 'investing-coach', name: 'Investing Coach', tags: ['learn', 'beginner', 'index fund', 'etf', 'retirement', 'roth', '401k', 'invest', 'compound'],
    mission: 'You are a patient teacher for someone learning to invest. Explain concepts step by step with small worked examples (compound growth, index funds, dollar-cost averaging, tax-advantaged accounts). End with one concrete next step and one thing to study.' },
  { id: 'options-educator', name: 'Options Educator', tags: ['options', 'calls', 'puts', 'derivatives', 'covered call', 'spread', 'leverage'],
    mission: 'You teach how options work: calls, puts, premiums, expiration, the Greeks at a basic level, and defined-risk strategies. Always spell out the maximum loss. Warn beginners away from undefined-risk positions such as naked short options.' },
  { id: 'devils-advocate', name: "Devil's Advocate", tags: ['risk', 'stocks', 'business', 'idea', 'plan', 'should i', 'worth it'],
    mission: 'Your job is to argue against the idea on the table. Find the strongest reasons it could fail, the hidden assumptions, and what the crowd is missing. Be specific and fair, not just negative.' },
  { id: 'business-strategist', name: 'Business Strategist', tags: ['business', 'startup', 'idea', 'side hustle', 'company', 'strategy', 'niche', 'market'],
    mission: 'You help the user start and grow businesses with little money. Assess ideas on demand, competition, startup cost, time to first dollar, and unit economics. Prefer cheap, testable first steps (talk to 10 customers, presell, landing page) over big upfront spending.' },
  { id: 'growth-marketer', name: 'Growth Marketer', tags: ['marketing', 'customers', 'sales', 'social media', 'ads', 'brand', 'content', 'launch', 'app store'],
    mission: 'You find customers using free or low-cost channels: content, short-form video, communities, SEO, partnerships, referrals, cold outreach. Give a concrete 7-day plan with specific actions and how to measure each one.' },
  { id: 'finance-ops', name: 'Finance & Ops', tags: ['pricing', 'cash flow', 'taxes', 'llc', 'bookkeeping', 'profit', 'budget', 'subscription'],
    mission: 'You handle the money side of running a business: pricing, budgets, cash flow, bookkeeping, basic tax concepts, and entity types like sole proprietorship vs LLC. Note when the user should confirm something with an accountant or attorney.' },
  { id: 'product-builder', name: 'Product Builder', tags: ['app', 'website', 'mvp', 'build', 'software', 'no-code', 'saas', 'product', 'boss ai'],
    mission: 'You help turn ideas into products: scoping an MVP, choosing simple tools (no-code, web apps, PWAs), and planning the path from website to Google Play and App Store. Keep scope small and shippable.' },
];

const MAX_AGENTS = () => intEnv('MAX_AGENTS', 150);
const state = () => {
  const s = load('agents', { agents: [] });
  for (const a of SEED) if (!s.agents.some((x) => x.id === a.id)) s.agents.push({ ...a, seed: true, createdAt: 0 });
  return s;
};

export function list() { return state().agents; }
export function get(id) { return list().find((a) => a.id === id) || null; }
export function findByName(name) {
  const n = String(name || '').toLowerCase().trim();
  return list().find((a) => a.name.toLowerCase() === n || a.id === n) || null;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const name = String(spec.name || '').replace(/[^\w &'\-/]/g, '').trim().slice(0, 40);
  const mission = String(spec.mission || '').trim().slice(0, 1200);
  const tags = (Array.isArray(spec.tags) ? spec.tags : [])
    .filter((t) => typeof t === 'string').map((t) => t.toLowerCase().trim().slice(0, 30)).filter(Boolean).slice(0, 8);
  if (name.length < 3 || mission.length < 20) return null;
  return { name, mission, tags };
}

export function spawn(spec, { createdBy, approvedBy, ownerModel }) {
  const clean = validateSpec(spec);
  if (!clean || findByName(clean.name)) return null;
  const s = state();
  if (s.agents.length >= MAX_AGENTS()) prune({ force: true });
  if (s.agents.length >= MAX_AGENTS()) return null;
  let id = slug(clean.name) || 'agent';
  while (get(id)) id += '-' + Math.random().toString(36).slice(2, 5);
  const agent = { id, ...clean, seed: false, ownerModel: ownerModel || createdBy || null, createdBy, approvedBy, createdAt: Date.now() };
  s.agents.push(agent);
  save('agents');
  return agent;
}

// Retire spawned agents with a consistently poor record; reassign agents
// whose owner model keeps underperforming.
export function prune({ force = false } = {}) {
  const s = state();
  const before = s.agents.length;
  s.agents = s.agents.filter((a) => {
    if (a.seed) return true;
    const n = learning.ratings('agents', a.id);
    const m = learning.meanScore('agents', a.id);
    if (n >= 8 && m < 0.35) return false;
    if (force && n >= 3 && m < 0.45) return false;
    return true;
  });
  for (const a of s.agents) {
    if (a.ownerModel && learning.ratings('models', a.ownerModel) >= 6 && learning.meanScore('models', a.ownerModel) < 0.35) a.ownerModel = null;
  }
  if (s.agents.length !== before) save('agents');
  return before - s.agents.length;
}

export function relevance(agent, text) {
  const t = text.toLowerCase();
  let hits = 0;
  for (const tag of agent.tags) if (t.includes(tag)) hits++;
  for (const w of agent.name.toLowerCase().split(/\W+/)) if (w.length > 3 && t.includes(w)) hits += 0.5;
  return hits;
}

// Fallback ranking when the supervisor's plan can't be parsed.
export function rankFor(text, k) {
  return list()
    .map((a) => ({ a, s: relevance(a, text) + learning.sampleScore('agents', a.id) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, k)
    .map((x) => x.a);
}

// Catalog shown to the supervisor when planning, most relevant first.
export function catalog(text, limit = 40) {
  return list()
    .map((a) => ({ a, s: relevance(a, text) + learning.meanScore('agents', a.id) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map(({ a }) => `${a.id}: ${a.name} [${a.tags.join(', ')}] - ${a.mission.split('. ')[0].slice(0, 140)}`)
    .join('\n');
}
