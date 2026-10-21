// Specialist agents. Nothing about the team is fixed in code:
//   - Starter agents come from agents.seed.json (editable) and are copied in
//     once. Set STARTER_AGENTS=0 to start empty and let the supervisor hire.
//   - The supervisor creates agents when no one fits; worker models propose
//     sub-agents and the supervisor approves or rejects them.
//   - The supervisor rewrites the instructions of agents doing badly.
//   - Any agent, starter or not, is retired if its record stays poor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save } from './store.js';
import * as learning from './learning.js';
import { intEnv } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGENTS = () => intEnv('MAX_AGENTS', 150);

function starterAgents() {
  if (process.env.STARTER_AGENTS === '0') return [];
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'agents.seed.json'), 'utf8')).agents || [];
  } catch {
    return [];
  }
}

const state = () => {
  const s = load('agents', { agents: [], seeded: false });
  if (!s.seeded) {
    for (const a of starterAgents()) {
      const clean = validateSpec(a);
      if (clean && a.id && !s.agents.some((x) => x.id === a.id)) s.agents.push({ id: a.id, ...clean, seed: true, createdAt: Date.now() });
    }
    s.seeded = true;
    save('agents');
  }
  return s;
};

export function list() { return state().agents; }
export function get(id) { return list().find((a) => a.id === id) || null; }
export function findByName(name) {
  const n = String(name || '').toLowerCase().trim();
  return list().find((a) => a.name.toLowerCase() === n || a.id === n) || null;
}

// Used only when the team is empty and the supervisor couldn't hire anyone.
export function generalist() {
  return { id: 'generalist', name: 'Generalist', tags: [], ephemeral: true,
    mission: 'You are a sharp, practical advisor on investing, trading and business. Answer the question directly and concretely.' };
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
  while (get(id) || id === 'generalist') id += '-' + Math.random().toString(36).slice(2, 5);
  const agent = { id, ...clean, seed: false, ownerModel: ownerModel || createdBy || null, createdBy, approvedBy, createdAt: Date.now() };
  s.agents.push(agent);
  save('agents');
  return agent;
}

// The supervisor rewrites the mission of an agent that just did badly. The
// agent's record is halved so the new instructions get a fair trial.
export function improve(id, mission, by) {
  const a = get(id);
  const text = String(mission || '').trim().slice(0, 1200);
  if (!a || text.length < 20 || text === a.mission) return false;
  a.history = [...(a.history || []), { mission: a.mission, replacedAt: Date.now(), by }].slice(-3);
  a.mission = text;
  learning.soften('agents', id, 0.5);
  save('agents');
  return true;
}

export function retire(id) {
  const s = state();
  const before = s.agents.length;
  s.agents = s.agents.filter((a) => a.id !== id);
  if (s.agents.length !== before) save('agents');
  return before !== s.agents.length;
}

// Retire agents with a consistently poor record; reassign agents whose
// owner model keeps underperforming.
export function prune({ force = false } = {}) {
  const s = state();
  const before = s.agents.length;
  s.agents = s.agents.filter((a) => {
    const n = learning.ratings('agents', a.id);
    const m = learning.meanScore('agents', a.id);
    if (n >= 8 && m < 0.35) return false;
    if (force && !a.seed && n >= 3 && m < 0.45) return false;
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
