// Tiny JSON-file persistence. Everything Boss learns lives in server/data/*.json,
// so it survives restarts on the Pi without needing a database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map();
const timers = new Map();

export function dataDir() {
  return process.env.BOSS_DATA_DIR || path.join(here, '..', 'data');
}

export function load(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(dataDir(), name + '.json'), 'utf8'));
  } catch {
    value = structuredClone(fallback);
  }
  cache.set(name, value);
  return value;
}

function writeNow(name) {
  if (!cache.has(name)) return;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name), null, 2));
  fs.renameSync(tmp, file);
}

// Writes are debounced so a burst of updates becomes one disk write.
export function save(name) {
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => { timers.delete(name); writeNow(name); }, 250).unref());
}

export function flush() {
  for (const [name, t] of timers) { clearTimeout(t); writeNow(name); }
  timers.clear();
}

export function _reset() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  cache.clear();
}
