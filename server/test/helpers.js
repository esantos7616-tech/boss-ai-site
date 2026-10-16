import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function freshEnv() {
  for (const k of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY',
    'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OLLAMA_URL', 'SUPERVISOR_MODEL', 'BOSS_ACCESS_KEY']) delete process.env[k];
  process.env.BOSS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-test-'));
  process.env.AUTO_DISCOVER = '0';
  process.env.MARKET_DATA = '0';
}

// Fake OpenAI-compatible endpoint: `responder(body, url)` returns the reply text.
export function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const out = await responder(body, String(url));
    if (out && out.status) {
      return new Response(out.text || '', { status: out.status, headers: out.headers || {} });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 });
  };
  return calls;
}
