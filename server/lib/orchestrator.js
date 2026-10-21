// How a question flows through Boss:
//   1. PLAN       the supervisor (lowest-hallucination model) picks which
//                 specialist agents should work on it, hires new ones when
//                 nobody fits, and decides what to look up on the web.
//   2. WORK       each agent runs on a different worker model in parallel,
//                 with verified market data, web results and your
//                 long-term memory. Agents can propose new sub-agents.
//   3. VERIFY     the supervisor checks the reports against the data and
//                 each other, writes the final answer, grades each agent,
//                 rewrites the instructions of agents that did badly,
//                 approves or rejects proposed agents, updates your
//                 watchlist if you asked, and notes what to remember.
//   4. LEARN      grades and your thumbs up/down update the routing scores.
import * as registry from './registry.js';
import * as agents from './agents.js';
import * as learning from './learning.js';
import * as market from './market.js';
import * as search from './search.js';
import * as watchlist from './watchlist.js';
import { chatCompletion, PROVIDERS } from './providers.js';
import { intEnv } from './env.js';

const RULES = `Ground rules:
- Never invent numbers, prices, dates, statistics, quotes, studies, tickers or sources. Current market figures may ONLY come from the VERIFIED MARKET DATA block. If you don't have a number, say so and say where to find it.
- News and recent events may ONLY come from the WEB RESULTS block; cite them as [n]. If there are no web results, say you can't check the latest news.
- Say "I'm not sure" rather than guess. Keep facts separate from opinions.
- Money topics: this is education, not personalized financial advice. Be honest about risk and never promise returns.
- Health, legal or safety topics: give general information and say when the user should see a professional.
- Be practical and specific. Write plain text: short paragraphs and "-" bullets. No markdown headings, tables or bold.`;

// ---------- parsing helpers (free models are sloppy with formats) ----------
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(s, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

export function tidy(text) {
  return String(text || '')
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseReport(text) {
  let body = text, suggestion = null, confidence = null;
  const na = body.search(/NEW_AGENT\s*:/i);
  if (na >= 0) {
    suggestion = agents.validateSpec(extractJson(body.slice(na)));
    body = body.slice(0, na);
  }
  const cm = body.match(/CONFIDENCE\s*:\s*(\d*\.?\d+)/i);
  if (cm) {
    confidence = Math.max(0, Math.min(1, parseFloat(cm[1]) > 1 ? parseFloat(cm[1]) / 100 : parseFloat(cm[1])));
    body = body.replace(/^.*CONFIDENCE\s*:.*$/gim, '');
  }
  return { body: tidy(body), confidence, suggestion };
}

export function parseSynthesis(text) {
  const m = text.match(/-{2,}\s*META\s*-{2,}/i);
  if (!m) return { answer: tidy(text), meta: {} };
  return { answer: tidy(text.slice(0, m.index)), meta: extractJson(text.slice(m.index)) || {} };
}

function formatHistory(history, current) {
  const h = (Array.isArray(history) ? history : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string');
  if (h.length && h.at(-1).role === 'user' && h.at(-1).content.trim() === current) h.pop();
  return h.slice(-8).map((x) => `${x.role === 'user' ? 'User' : 'Boss'}: ${x.content.slice(0, 600)}`).join('\n');
}

// ---------- model calls ----------
async function call(model, messages, opts) {
  const t0 = Date.now();
  try {
    const text = await chatCompletion(model, messages, opts);
    registry.reportSuccess(model, Date.now() - t0);
    return text;
  } catch (err) {
    registry.reportFailure(model, err);
    throw err;
  }
}

// Try models in order until one answers.
async function callFirst(models, messages, opts, max = 3) {
  let lastErr, tried = 0;
  for (const m of models) {
    if (tried >= max) break;
    if (!registry.isAvailable(m)) continue;
    tried++;
    try { return { model: m, text: await call(m, messages, opts) }; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no model available');
}

// ---------- prompts ----------
function planMessages(text, convo, mem, k, maxNew) {
  const catalog = agents.catalog(text);
  return [
    { role: 'system', content:
`You are BOSS, the supervisor of an AI team that is one user's personal assistant, like Jarvis. The user can ask about anything: investing, trading and building businesses (their main goals), and also school, coding, writing, health and fitness, planning, and general knowledge. You were made supervisor because you hallucinate the least. In this step you only PLAN. You do not answer.

${catalog ? 'Specialist agents on your team (id: name [tags] - mission):\n' + catalog : 'Your team is EMPTY. You must hire the specialists this question needs using new_agents.'}

Reply with ONLY a JSON object:
{"intent":"quote|trading|investing|business|learning|coding|writing|health|general|chat","needs_team":true,"agents":["agent-id"],"new_agents":[],"search":[],"symbols":[],"direct_reply":""}
- intent "quote" means the user only wants the current price or basic numbers for stocks, ETFs, indexes or crypto, with no analysis or advice.
- symbols: every stock, ETF, index or crypto the user mentions. Use the ticker only if you are certain of it; otherwise write the company or asset name as the user wrote it (e.g. "Rocket Lab"). Never guess a ticker. [] if none.
- agents: pick 1 to ${k} agents whose expertise fits best. For any buy/sell or money decision, include one agent whose job is risk or arguing the other side, hiring one if needed.
- new_agents: up to ${maxNew} new specialists {"name","mission","tags"} when no agent on the team fits. Make each one a reusable specialist, not a one-off. Write the mission in second person ("You ...") and include how they should avoid mistakes. New agents automatically work on this question.
- search: up to 2 web search queries if the question needs news, recent events, or facts that may have changed (company news, regulations, prices of products, current trends). Otherwise [].
- Set needs_team=false only for greetings, thanks or small talk, and put a short friendly reply in direct_reply.` },
    { role: 'user', content: [mem, convo && 'Recent conversation:\n' + convo, 'New message: ' + text].filter(Boolean).join('\n\n') },
  ];
}

function agentMessages(agent, text, convo, mem, marketText, webText) {
  return [
    { role: 'system', content: `You are ${agent.name}, a specialist on the Boss AI team. ${agent.mission}\n\n${RULES}${mem ? '\n\n' + mem : ''}` },
    { role: 'user', content: [
      marketText,
      webText,
      convo && 'Recent conversation:\n' + convo,
      `User's question: ${text}`,
      `Write your report for the supervisor in under 300 words. Then end with these two lines:
CONFIDENCE: <0.0-1.0, how likely your report is accurate>
NEW_AGENT: <none, or a JSON object {"name","mission","tags"} for a new specialist sub-agent that would help this user in future conversations. Suggest one only if it fills a real gap; usually write none.>`,
    ].filter(Boolean).join('\n\n') },
  ];
}

function synthMessages(text, convo, mem, marketText, webText, reports, proposals) {
  const team = reports.map((r) =>
    `[${r.agent.id}] ${r.agent.name} (model family ${r.model.family}, self-confidence ${r.confidence ?? 'n/a'}):\n${r.body}`).join('\n\n');
  const props = proposals.length
    ? '\n\nPROPOSED NEW AGENTS (approve only useful, non-duplicate ones):\n' + proposals.map((p) => `- ${p.spec.name}: ${p.spec.mission.slice(0, 220)}`).join('\n')
    : '';
  return [
    { role: 'system', content:
`You are BOSS, the supervising AI. You were picked to lead because you hallucinate the least, so you are the final check on accuracy. Your team's reports are below.
1. Check every claim. Remove or correct anything that contradicts the VERIFIED MARKET DATA, contradicts another report without support, or states a specific number or fact that is not verified.
2. Where agents disagree, say so briefly and say which view is better supported.
3. Write ONE clear, practical answer directly to the user. You are talking to them, not to the team. For money decisions, include the main risks and a concrete next step.

${RULES}${mem ? '\n\n' + mem : ''}

After the answer, write a line containing only ---META--- and then a JSON object:
{"consensus":"high|medium|low","agent_scores":{"<agent-id>":<0.0-1.0 accuracy and usefulness>},"approve_agents":["<exact name of each proposed agent worth creating>"],"improve_agents":[{"id":"<agent-id you scored below 0.4>","mission":"<rewritten instructions that fix what it got wrong>"}],"remember":["<lasting facts about the user, such as goals, budget, risk tolerance or experience; [] if none>"],"watchlist_add":[],"watchlist_remove":[]}
Only fill watchlist_add or watchlist_remove with tickers when the user explicitly asks to add or remove them.` },
    { role: 'user', content: [marketText, webText, convo && 'Recent conversation:\n' + convo, `User's question: ${text}`, 'TEAM REPORTS:\n' + team + props].filter(Boolean).join('\n\n') },
  ];
}

export function setupMessage() {
  const lines = Object.values(PROVIDERS).map((p) => `- ${p.label}: ${p.keyEnv || p.requires?.join(', ')} (${p.signup})`);
  return `Boss is running, but no free LLM providers are connected yet. Add at least one free key to server/.env and restart:\n\n${lines.join('\n')}\n\nEach provider you add unlocks more of the 30 models. Gemini + Groq + OpenRouter alone cover 18 of them.`;
}

// ---------- main entry ----------
// opts (used by the daily briefing): symbols, newsQueries, forceTeam, label.
export async function handle(message, history = [], opts = {}) {
  const text = String(message || '').trim().slice(0, 4000);
  if (!text) return { message: 'Say something and the team will get to work.' };
  if (text.toLowerCase() === 'ping') return { message: 'pong', meta: { ping: true } };

  const supers = registry.supervisorCandidates();
  if (!supers.length) return { message: setupMessage(), meta: { setup: true } };

  const k = Math.max(1, intEnv('WORKERS_PER_QUERY', 4));
  const convo = formatHistory(history, text);
  const mem = learning.memoryContext();
  let symbols = [...new Set([...market.extractTickers(text), ...(opts.symbols || [])])].slice(0, 10);
  const marketPromise = market.contextFor(symbols);
  const maxNew = Math.max(1, Math.min(3, k - agents.list().length));

  // 1. PLAN
  let supervisor = supers[0], plan = null;
  try {
    const r = await callFirst(supers, planMessages(text, convo, mem, k, maxNew), { temperature: 0.2, maxTokens: 900 });
    supervisor = r.model;
    plan = extractJson(r.text);
  } catch { /* fall back to keyword routing below */ }

  const intent = typeof plan?.intent === 'string' ? plan.intent : 'general';
  if (!opts.forceTeam && plan && plan.needs_team === false && typeof plan.direct_reply === 'string' && plan.direct_reply.trim()) {
    const interactionId = learning.logInteraction({ question: text.slice(0, 300), supervisor: supervisor.id, intent, used: [] });
    return { message: tidy(plan.direct_reply), meta: { interactionId, supervisor: brief(supervisor), intent, team: [], consensus: 'n/a' } };
  }

  // Turn the company names / tickers the supervisor spotted into verified tickers.
  const hints = (Array.isArray(plan?.symbols) ? plan.symbols : []).filter((h) => typeof h === 'string' && h.trim()).slice(0, 6);
  const resolved = hints.length ? await market.resolve(hints) : { symbols: [], missing: [] };
  symbols = [...new Set([...resolved.symbols, ...symbols])].slice(0, 10);

  // Price-only questions are answered from the data by code: fast, free, exact.
  if (intent === 'quote' && !opts.forceTeam && (resolved.symbols.length || resolved.missing.length)) {
    const ctx = await market.contextFor(resolved.symbols);
    const interactionId = learning.logInteraction({ question: text.slice(0, 300), supervisor: supervisor.id, intent, used: [] });
    return {
      message: market.priceAnswer(ctx.quotes, [...resolved.missing, ...ctx.failed]),
      meta: { interactionId, supervisor: brief(supervisor), intent, team: [], consensus: 'n/a', verified: ctx.quotes.length > 0, market: ctx.symbols },
    };
  }

  const queries = (Array.isArray(plan?.search) ? plan.search : []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 2);
  const newsQueries = [...(opts.newsQueries || [])];
  if (/trad|invest/.test(intent)) for (const s of symbols.slice(0, 2)) newsQueries.push(`${s} stock`);
  const webPromise = search.contextFor({ queries, newsQueries });

  let marketCtx = hints.length ? await market.contextFor(symbols) : await marketPromise;
  if (!symbols.length && /trad|invest/.test(intent)) {
    symbols = ['SPY', 'QQQ'];
    marketCtx = await market.contextFor(symbols);
  }
  const webCtx = await webPromise;

  // Workers: every available model except the supervisor.
  const workers = registry.available().filter((m) => m.id !== supervisor.id);
  const pool = workers.length ? workers : [supervisor];
  const used = new Set();
  const bonus = (m) => {
    const want = /trad|invest/.test(intent) ? 'finance' : intent === 'business' ? 'business' : 'reasoning';
    return (m.strengths || []).includes(want) ? 0.1 : 0;
  };
  const pickWorker = (agent) => {
    const owner = agent.ownerModel && registry.find(agent.ownerModel);
    if (owner && registry.isAvailable(owner) && !used.has(owner.id)) return owner;
    return pool
      .map((m) => ({ m, s: learning.sampleScore('models', m.id) + bonus(m) - (used.has(m.id) ? 0.5 : 0) }))
      .sort((a, b) => b.s - a.s)[0].m;
  };

  let chosen = [];
  for (const id of Array.isArray(plan?.agents) ? plan.agents : []) {
    const a = agents.get(String(id)) || agents.findByName(String(id));
    if (a && !chosen.includes(a)) chosen.push(a);
  }
  chosen = chosen.slice(0, k);

  // Agents the supervisor decided to hire while planning.
  const spawned = [];
  for (const spec of (Array.isArray(plan?.new_agents) ? plan.new_agents : []).slice(0, maxNew)) {
    const a = agents.spawn(spec, { createdBy: supervisor.id, approvedBy: supervisor.id, ownerModel: pickWorker({}).id });
    if (!a) continue;
    spawned.push(a.name);
    if (chosen.length >= k) chosen.pop();
    chosen.push(a);
  }
  if (!chosen.length) chosen = agents.rankFor(text, k);
  if (!chosen.length) chosen = [agents.generalist()];

  // 2. WORK (in parallel, each agent on its own model where possible)
  const byReliability = [...pool].sort((a, b) => learning.reliability(b.id) - learning.reliability(a.id));
  const reports = (await Promise.all(chosen.map(async (agent) => {
    const first = pickWorker(agent);
    used.add(first.id);
    try {
      const r = await callFirst([first, ...byReliability.filter((m) => m !== first)],
        agentMessages(agent, text, convo, mem, marketCtx.text, webCtx.text), { temperature: 0.5, maxTokens: 900 }, 2);
      return { agent, model: r.model, ...parseReport(r.text) };
    } catch {
      return null;
    }
  }))).filter((r) => r && r.body);

  if (!reports.length) {
    return { message: "None of the team's models answered. The free providers are probably rate-limiting, or the Pi lost its internet connection. Wait a minute and try again, or add more free keys so Boss has more models to fall back on.", meta: { error: 'no_reports' } };
  }

  const proposals = reports.filter((r) => r.suggestion).map((r) => ({ spec: r.suggestion, from: r.model.id }));

  // 3. VERIFY + SYNTHESIZE
  let answer, meta = {}, synthBy = supervisor;
  try {
    const r = await callFirst([supervisor, ...supers.filter((m) => m !== supervisor)],
      synthMessages(text, convo, mem, marketCtx.text, webCtx.text, reports, proposals), { temperature: 0.2, maxTokens: 1600 });
    synthBy = r.model;
    ({ answer, meta } = parseSynthesis(r.text));
  } catch { /* handled below */ }
  if (!answer) {
    const best = [...reports].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    answer = `(The supervisor was unavailable, so this answer from ${best.agent.name} has not been cross-checked.)\n\n${best.body}`;
    meta = {};
  }

  // 4. LEARN from the supervisor's grading (counts for less than your feedback).
  const scores = meta.agent_scores && typeof meta.agent_scores === 'object' ? meta.agent_scores : {};
  for (const r of reports) {
    const s = Number(scores[r.agent.id]);
    if (!Number.isFinite(s)) continue;
    learning.reward('agents', r.agent.id, s, 0.3);
    learning.reward('models', r.model.id, s, 0.3);
  }
  const approved = new Set((Array.isArray(meta.approve_agents) ? meta.approve_agents : []).map((n) => String(n).toLowerCase().trim()));
  for (const p of proposals) {
    if (!approved.has(p.spec.name.toLowerCase())) continue;
    const a = agents.spawn(p.spec, { createdBy: p.from, approvedBy: synthBy.id, ownerModel: p.from });
    if (a) spawned.push(a.name);
  }
  const improved = [];
  for (const fix of Array.isArray(meta.improve_agents) ? meta.improve_agents : []) {
    const id = String(fix?.id || '');
    if (Number(scores[id]) < 0.4 && reports.some((r) => r.agent.id === id) && agents.improve(id, fix.mission, synthBy.id)) improved.push(agents.get(id).name);
  }
  if (Array.isArray(meta.remember)) learning.addFacts(meta.remember);
  if (Array.isArray(meta.watchlist_add)) watchlist.add(meta.watchlist_add);
  if (Array.isArray(meta.watchlist_remove)) watchlist.remove(meta.watchlist_remove);

  const interactionId = learning.logInteraction({
    question: text.slice(0, 300), supervisor: synthBy.id, intent,
    used: reports.map((r) => ({ agentId: r.agent.id, modelId: r.model.id })),
  });

  return {
    message: answer,
    meta: {
      interactionId,
      supervisor: brief(synthBy),
      intent,
      consensus: ['high', 'medium', 'low'].includes(meta.consensus) ? meta.consensus : 'unknown',
      team: reports.map((r) => ({ agent: r.agent.name, model: r.model.id, confidence: r.confidence })),
      failed: chosen.length - reports.length,
      spawned,
      improved,
      market: marketCtx.symbols,
      sources: webCtx.sources,
      watchlist: watchlist.list(),
      ...(opts.label ? { label: opts.label } : {}),
    },
  };
}

const brief = (m) => ({ id: m.id, family: m.family });

export function feedback({ interactionId, rating, comment }) {
  const i = learning.getInteraction(interactionId);
  if (!i) return { ok: false, error: 'unknown interaction' };
  if (i.rating) return { ok: true, already: true };
  const v = Number(rating) > 0 ? 1 : 0;
  for (const u of i.used) {
    learning.reward('agents', u.agentId, v);
    learning.reward('models', u.modelId, v);
  }
  learning.reward('models', i.supervisor, v);
  learning.markRated(interactionId, v ? 1 : -1);
  const note = typeof comment === 'string' ? comment.trim().slice(0, 240) : '';
  if (note) learning.addLesson(`${v ? 'Liked' : 'Disliked'} the answer to "${i.question.slice(0, 100)}": ${note}`);
  return { ok: true, retired: agents.prune() };
}
