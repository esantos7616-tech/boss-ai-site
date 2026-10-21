// Tickers you care about. Edited from the Team panel, or just by telling Boss
// "add NVDA to my watchlist".
import { load, save } from './store.js';

const state = () => load('watchlist', { symbols: [] });
const valid = (s) => /^[A-Z]{1,5}([.-][A-Z]{1,3})?$/.test(s);
const norm = (s) => String(s || '').trim().replace(/^\$/, '').toUpperCase();

export function list() { return state().symbols; }

export function add(symbols) {
  const s = state();
  for (const sym of (Array.isArray(symbols) ? symbols : []).map(norm)) {
    if (valid(sym) && !s.symbols.includes(sym) && s.symbols.length < 20) s.symbols.push(sym);
  }
  save('watchlist');
  return s.symbols;
}

export function remove(symbols) {
  const s = state();
  const drop = new Set((Array.isArray(symbols) ? symbols : []).map(norm));
  s.symbols = s.symbols.filter((x) => !drop.has(x));
  save('watchlist');
  return s.symbols;
}
