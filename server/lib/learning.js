// Adaptive learning. LLM weights can't be retrained on free APIs, so Boss
// learns *around* the models instead:
//   1. Every model and agent has a win/loss record (from your thumbs up/down
//      plus the supervisor's grading of each report). Routing uses Thompson
//      sampling on those records, so models and agents that do well get used
//      more, and newcomers still get tried.
//   2. Measured hallucination rates (from `npm run benchmark`) decide who supervises.
//   3. A long-term memory of facts about you plus lessons from bad answers is
//      added to every prompt.
import crypto from 'node:crypto';
import { load, save } from './store.js';

const FILE = 'learning';
const EMPTY = { models: {}, agents: {}, interactions: [], memory: { facts: [], lessons: [] } };

const state = () => load(FILE, EMPTY);
const blank = () => ({ calls: 0, fails: 0, latencyMs: 0, wins: 0, losses: 0, hallu: { n: 0, wrong: 0 } });

function rec(kind, id) {
  const bucket = state()[kind];
  return (bucket[id] ||= blank());
}

export function stats(kind, id) { return rec(kind, id); }

export function recordCall(modelId, ok, ms) {
  const r = rec('models', modelId);
  r.calls++;
  if (!ok) r.fails++;
  else r.latencyMs = r.latencyMs ? Math.round(r.latencyMs * 0.8 + ms * 0.2) : Math.round(ms);
  save(FILE);
}

// value in [0,1]; weight lets the supervisor's grading count for less than your feedback.
export function reward(kind, id, value, weight = 1) {
  const r = rec(kind, id);
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  r.wins += weight * v;
  r.losses += weight * (1 - v);
  save(FILE);
}

// Shrink a record toward "unknown" so a changed agent gets a fresh trial.
export function soften(kind, id, factor) {
  const r = rec(kind, id);
  r.wins *= factor;
  r.losses *= factor;
  save(FILE);
}

export function meanScore(kind, id) {
  const r = rec(kind, id);
  return (r.wins + 1) / (r.wins + r.losses + 2);
}

export function ratings(kind, id) {
  const r = rec(kind, id);
  return r.wins + r.losses;
}

export function reliability(modelId) {
  const r = rec('models', modelId);
  return (r.calls - r.fails + 1) / (r.calls + 2);
}

// Thompson sample: quality x reliability, so flaky free endpoints get used less.
export function sampleScore(kind, id) {
  const r = rec(kind, id);
  const q = betaSample(r.wins + 1, r.losses + 1);
  return kind === 'models' ? q * reliability(id) : q;
}

export function recordHallucination(modelId, wrong) {
  const r = rec('models', modelId);
  r.hallu.n++;
  if (wrong) r.hallu.wrong++;
  save(FILE);
}

export function resetHallucination(modelId) {
  rec('models', modelId).hallu = { n: 0, wrong: 0 };
  save(FILE);
}

export function hallucinationRate(modelId) {
  const { n, wrong } = rec('models', modelId).hallu;
  return { n, rate: n ? wrong / n : null };
}

// ---- interaction log (so feedback can be credited to the right agents) ----
export function logInteraction(entry) {
  const s = state();
  const id = crypto.randomUUID();
  s.interactions.push({ id, ts: Date.now(), ...entry });
  if (s.interactions.length > 300) s.interactions.splice(0, s.interactions.length - 300);
  save(FILE);
  return id;
}

export function getInteraction(id) {
  return state().interactions.find((i) => i.id === id) || null;
}

export function markRated(id, rating) {
  const i = getInteraction(id);
  if (i) { i.rating = rating; save(FILE); }
}

// ---- long-term memory ----
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

export function addFacts(facts) {
  const mem = state().memory;
  for (const f of facts || []) {
    if (typeof f !== 'string') continue;
    const text = f.trim().slice(0, 240);
    if (text.length < 4 || mem.facts.some((x) => norm(x) === norm(text))) continue;
    mem.facts.push(text);
  }
  if (mem.facts.length > 60) mem.facts.splice(0, mem.facts.length - 60);
  save(FILE);
}

export function addLesson(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  const mem = state().memory;
  mem.lessons.push(text.trim().slice(0, 300));
  if (mem.lessons.length > 40) mem.lessons.splice(0, mem.lessons.length - 40);
  save(FILE);
}

export function forget() {
  state().memory = { facts: [], lessons: [] };
  save(FILE);
}

export function memory() { return state().memory; }

export function memoryContext() {
  const { facts, lessons } = state().memory;
  const parts = [];
  if (facts.length) parts.push('WHAT YOU KNOW ABOUT THE USER:\n' + facts.map((f) => '- ' + f).join('\n'));
  if (lessons.length) parts.push('LESSONS FROM PAST FEEDBACK (follow these):\n' + lessons.slice(-12).map((l) => '- ' + l).join('\n'));
  return parts.join('\n\n');
}

// ---- Beta sampling via Marsaglia-Tsang gamma ----
function normal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gamma(k) {
  if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(a, b) {
  const x = gamma(a), y = gamma(b);
  return x / (x + y);
}
