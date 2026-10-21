// The model roster: the 30 core models in models.json, plus free models
// auto-discovered from OpenRouter (self-expanding). Tracks which ones are
// usable right now and picks the supervisor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, providerReady } from './providers.js';
import { load, save } from './store.js';
import * as learning from './learning.js';
import { intEnv } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = JSON.parse(fs.readFileSync(path.join(here, '..', 'models.json'), 'utf8')).models;
const benched = new Map(); // modelId -> { until, reason }

const discovered = () => load('discovered', { lastRun: 0, models: [] });

export function coreModels() { return CORE; }

export function allModels() {
  const seen = new Set(CORE.map((m) => m.model + '@' + m.provider));
  return [...CORE, ...discovered().models.filter((m) => !seen.has(m.model + '@' + m.provider))];
}

export function find(id) { return allModels().find((m) => m.id === id) || null; }

export function benchInfo(id) {
  const b = benched.get(id);
  return b && b.until > Date.now() ? b : null;
}

export function isAvailable(m) {
  return !!m && providerReady(m.provider) && !benchInfo(m.id);
}

export function available() { return allModels().filter(isAvailable); }

export function readyProviders() { return Object.keys(PROVIDERS).filter(providerReady); }

export function reportSuccess(m, ms) { learning.recordCall(m.id, true, ms); }

// Free tiers rate-limit and retire models; bench a failing model for a while
// instead of retrying it on every request.
export function reportFailure(m, err) {
  learning.recordCall(m.id, false, 0);
  const s = err?.status || 0;
  let ms = 20_000, reason = err?.message || 'error';
  if (s === 429) { ms = Math.max((err.retryAfterSec || 0) * 1000, 60_000); reason = 'rate limited'; }
  else if (s === 401 || s === 403) { ms = 30 * 60_000; reason = 'key rejected'; }
  else if (s === 404 || s === 400 || s === 422) { ms = 6 * 3600_000; reason = 'model unavailable'; }
  else if (s >= 500) ms = 60_000;
  benched.set(m.id, { until: Date.now() + ms, reason });
}

// Lower is better. A measured hallucination rate (after enough benchmark
// questions) beats a guess; supervisorRank is the starting guess.
export function supervisorKey(m) {
  const { n, rate } = learning.hallucinationRate(m.id);
  if (n >= 8) return (rate * n + 0.5) / (n + 1); // smoothed so 0/8 isn't treated as perfect
  if (m.supervisorRank) return 0.06 + 0.01 * m.supervisorRank;
  return 1;
}

export function supervisorCandidates() {
  const pool = available();
  const pinned = process.env.SUPERVISOR_MODEL;
  const sorted = pool
    .filter((m) => supervisorKey(m) < 1)
    .sort((a, b) => supervisorKey(a) - supervisorKey(b) || learning.reliability(b.id) - learning.reliability(a.id));
  const rest = pool.filter((m) => !sorted.includes(m)).sort((a, b) => learning.reliability(b.id) - learning.reliability(a.id));
  const list = [...sorted, ...rest];
  const pin = list.find((m) => m.id === pinned);
  return pin ? [pin, ...list.filter((m) => m !== pin)] : list;
}

export function pickSupervisor() { return supervisorCandidates()[0] || null; }

// Self-expansion: OpenRouter lists new zero-cost models all the time.
export async function discover({ force = false } = {}) {
  const d = discovered();
  if (process.env.AUTO_DISCOVER === '0' || !providerReady('openrouter')) return d.models;
  if (!force && Date.now() - d.lastRun < 24 * 3600_000) return d.models;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('status ' + res.status);
    const { data } = await res.json();
    const known = new Set(CORE.map((m) => m.model));
    const free = (data || [])
      .filter((x) => x.id?.endsWith(':free') && Number(x.pricing?.prompt) === 0 && Number(x.pricing?.completion) === 0)
      .filter((x) => !known.has(x.id) && (x.context_length || 0) >= 8000)
      .slice(0, intEnv('DISCOVER_MAX', 20))
      .map((x) => ({
        id: 'or-auto-' + x.id.replace(/:free$/, '').replace(/[^a-z0-9.]+/gi, '-').toLowerCase(),
        provider: 'openrouter',
        model: x.id,
        family: (x.name || x.id).split(':')[0].split(' ')[0],
        strengths: ['general'],
        discovered: true,
      }));
    d.models = free;
    d.lastRun = Date.now();
    save('discovered');
  } catch (err) {
    console.warn('[discover] failed:', err.message);
  }
  return d.models;
}
