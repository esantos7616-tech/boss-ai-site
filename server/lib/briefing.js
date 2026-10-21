// Daily briefing, Jarvis style: every morning at BRIEFING_TIME (Pi's local
// time) the whole team prepares a market summary, watchlist moves with
// headlines, one business task for the day, and one thing to learn. The site
// shows it as soon as you open it (and reads it aloud if voice replies are on).
import crypto from 'node:crypto';
import { load, save } from './store.js';
import * as orchestrator from './orchestrator.js';
import * as watchlist from './watchlist.js';
import * as registry from './registry.js';

const state = () => load('briefings', { items: [], lastDate: null });
let running = null;

const today = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

export function latest() { return state().items.at(-1) || null; }
export function isRunning() { return !!running; }

export function briefingTime() {
  const v = (process.env.BRIEFING_TIME || '07:30').trim().toLowerCase();
  if (v === 'off' || v === '0') return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  return m ? { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]), label: v } : { h: 7, m: 30, label: '07:30' };
}

export function isDue(now = new Date()) {
  const t = briefingTime();
  if (!t || state().lastDate === today(now)) return false;
  return now.getHours() * 60 + now.getMinutes() >= t.h * 60 + t.m;
}

export function generate() {
  if (running) return running;
  running = (async () => {
    const wl = watchlist.list();
    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const prompt = `Give me my daily briefing for ${dateLabel}. Cover, in this order, with a short heading line for each:
1. Market: what the major indexes did, using only the verified data, plus the most important headline.
2. Watchlist: ${wl.length ? `notable moves in ${wl.join(', ')} and why they might matter, citing headlines.` : 'my watchlist is empty, so suggest how to build one that fits my goals (no specific buy recommendations).'}
3. Today's business task: one concrete task I can finish today that moves my goals forward.
4. Learn: one investing or business concept to study today, explained in two sentences.
Keep it tight and skimmable.`;
    const out = await orchestrator.handle(prompt, [], {
      symbols: ['SPY', 'QQQ', 'DIA', ...wl],
      newsQueries: ['stock market today', ...wl.slice(0, 3).map((s) => `${s} stock`)],
      forceTeam: true,
      label: 'Briefing · ' + dateLabel,
    });
    const item = { id: crypto.randomUUID(), date: today(), createdAt: Date.now(), message: out.message, meta: out.meta || {} };
    const s = state();
    s.items.push(item);
    if (s.items.length > 14) s.items.splice(0, s.items.length - 14);
    if (!out.meta?.error && !out.meta?.setup) s.lastDate = item.date;
    save('briefings');
    return item;
  })().finally(() => { running = null; });
  return running;
}

export function startScheduler() {
  const tick = () => {
    if (!isDue() || running || !registry.available().length) return;
    generate()
      .then((b) => console.log(`[briefing] ready for ${b.date}`))
      .catch((e) => console.warn('[briefing] failed:', e.message));
  };
  tick();
  return setInterval(tick, 60_000).unref();
}
