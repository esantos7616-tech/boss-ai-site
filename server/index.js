// Boss AI backend. Zero dependencies: needs only Node 18+.
//   cd server && cp .env.example .env   (add your free keys)
//   node index.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv, intEnv } from './lib/env.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));

const registry = await import('./lib/registry.js');
const agents = await import('./lib/agents.js');
const learning = await import('./lib/learning.js');
const orchestrator = await import('./lib/orchestrator.js');
const { benchmarkAll } = await import('./lib/benchmark.js');
const briefing = await import('./lib/briefing.js');
const watchlist = await import('./lib/watchlist.js');
const { PROVIDERS, providerReady } = await import('./lib/providers.js');
const store = await import('./lib/store.js');

const PORT = intEnv('PORT', 3000);
const ACCESS_KEY = process.env.BOSS_ACCESS_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const SITE = path.join(root, '..', 'index.html');

function cors(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Boss-Key');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// The tunnel URL is public, so an access key stops strangers from burning your free quotas.
function authorized(req) {
  if (!ACCESS_KEY) return true;
  const got = Buffer.from(String(req.headers['x-boss-key'] || ''));
  const want = Buffer.from(ACCESS_KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function teamSnapshot() {
  const sup = registry.pickSupervisor();
  return {
    supervisor: sup?.id || null,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, ready: providerReady(id), signup: p.signup })),
    models: registry.allModels().map((m) => {
      const s = learning.stats('models', m.id);
      const h = learning.hallucinationRate(m.id);
      return {
        id: m.id, provider: m.provider, family: m.family, discovered: !!m.discovered,
        available: registry.isAvailable(m), benched: registry.benchInfo(m.id)?.reason || null,
        score: +learning.meanScore('models', m.id).toFixed(3), reliability: +learning.reliability(m.id).toFixed(3),
        calls: s.calls, latencyMs: s.latencyMs, hallucinationRate: h.rate, hallucinationTests: h.n,
      };
    }),
    agents: agents.list().map((a) => ({
      id: a.id, name: a.name, seed: !!a.seed, tags: a.tags, owner: a.ownerModel || null, createdBy: a.createdBy || null,
      score: +learning.meanScore('agents', a.id).toFixed(3), ratings: +learning.ratings('agents', a.id).toFixed(1),
    })),
    memory: learning.memory(),
    watchlist: watchlist.list(),
    briefingTime: briefing.briefingTime()?.label || 'off',
    webSearch: process.env.WEB_SEARCH === '0' ? 'off' : process.env.TAVILY_API_KEY ? 'Tavily' : process.env.BRAVE_API_KEY ? 'Brave' : 'DuckDuckGo + Google News',
  };
}

let benchmarkRunning = false;

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(SITE).on('error', () => res.end('Boss AI backend is running.')).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const avail = registry.available();
      return send(res, 200, {
        ok: true, authorized: authorized(req), needsKey: !!ACCESS_KEY,
        supervisor: registry.pickSupervisor()?.id || null,
        availableModels: avail.length, totalModels: registry.allModels().length, agents: agents.list().length,
      });
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (!authorized(req)) return send(res, 401, { error: 'Missing or wrong access key. Add it in Settings.' });

    if (req.method === 'POST' && url.pathname === '/api/ai-chat') {
      const body = await readJson(req);
      const out = await orchestrator.handle(body.message, body.history);
      return send(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      const body = await readJson(req);
      return send(res, 200, orchestrator.feedback(body));
    }

    if (req.method === 'GET' && url.pathname === '/api/team') return send(res, 200, teamSnapshot());

    if (req.method === 'GET' && url.pathname === '/api/briefing/latest') {
      return send(res, 200, { briefing: briefing.latest(), running: briefing.isRunning() });
    }

    if (req.method === 'POST' && url.pathname === '/api/briefing') {
      if (!registry.available().length) return send(res, 200, { briefing: null, error: 'No models available yet. Add free API keys first.' });
      return send(res, 200, { briefing: await briefing.generate() });
    }

    if (req.method === 'GET' && url.pathname === '/api/watchlist') return send(res, 200, { symbols: watchlist.list() });

    if (req.method === 'POST' && url.pathname === '/api/watchlist') {
      const body = await readJson(req);
      if (body.add) watchlist.add(body.add);
      if (body.remove) watchlist.remove(body.remove);
      return send(res, 200, { symbols: watchlist.list() });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/')) {
      return send(res, 200, { ok: agents.retire(decodeURIComponent(url.pathname.slice('/api/agents/'.length))) });
    }

    if (req.method === 'POST' && url.pathname === '/api/memory/forget') {
      learning.forget();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/benchmark') {
      if (benchmarkRunning) return send(res, 409, { error: 'benchmark already running' });
      benchmarkRunning = true;
      benchmarkAll().then((r) => console.log('[benchmark] done:', r.map((x) => `${x.id}=${x.rate}`).join(' ')))
        .catch((e) => console.warn('[benchmark] failed:', e.message))
        .finally(() => { benchmarkRunning = false; });
      return send(res, 202, { ok: true, started: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    if (!err.status) console.error('[error]', err);
    return send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
});

server.listen(PORT, async () => {
  const ready = Object.keys(PROVIDERS).filter(providerReady);
  console.log(`Boss AI listening on http://localhost:${PORT}`);
  console.log(`Providers connected: ${ready.join(', ') || 'none (add free keys to server/.env)'}`);
  await registry.discover();
  console.log(`Models available: ${registry.available().length}/${registry.allModels().length}, supervisor: ${registry.pickSupervisor()?.id || 'none'}`);
  briefing.startScheduler();
  const bt = briefing.briefingTime();
  console.log(`Daily briefing: ${bt ? bt.label + ' (local time)' : 'off'}`);
  if (!ACCESS_KEY) console.warn('Warning: BOSS_ACCESS_KEY is not set, so anyone with your tunnel URL can use your quotas.');
});

setInterval(() => registry.discover(), 6 * 3600_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { store.flush(); process.exit(0); });
}
