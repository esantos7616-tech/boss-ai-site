#!/usr/bin/env node
// Usage: npm run benchmark            (all available models)
//        npm run benchmark -- gh-gpt-4.1-mini groq-llama-3.3-70b
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));

const registry = await import('../lib/registry.js');
const { benchmarkModel } = await import('../lib/benchmark.js');
const store = await import('../lib/store.js');

const ids = process.argv.slice(2);
const models = ids.length ? ids.map(registry.find).filter(Boolean) : registry.available();
if (!models.length) {
  console.log('No available models. Add free API keys to server/.env first (see .env.example).');
  process.exit(1);
}

console.log(`Benchmarking ${models.length} model(s) for hallucinations...\n`);
const results = [];
for (const m of models) {
  process.stdout.write(`${m.id.padEnd(28)} `);
  const r = await benchmarkModel(m, { onResult: ({ ok, error }) => process.stdout.write(error ? 'x' : ok ? '.' : 'F') });
  results.push(r);
  console.log(r.answered ? `  ${(r.rate * 100).toFixed(0)}% wrong (${r.wrong}/${r.answered})` : '  unavailable');
  await new Promise((res) => setTimeout(res, 1500));
}

store.flush();
const ranked = results.filter((r) => r.answered >= 8).sort((a, b) => a.rate - b.rate);
console.log('\nLowest hallucination rate (becomes supervisor):', ranked[0]?.id || 'not enough data');
console.log('Supervisor order now:', registry.supervisorCandidates().slice(0, 5).map((m) => m.id).join(' > '));
