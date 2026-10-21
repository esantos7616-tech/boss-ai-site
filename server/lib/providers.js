// Every provider below speaks the OpenAI chat-completions format, so one
// adapter covers all of them. All have free tiers; Ollama runs locally.
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai',
  },
  mistral: {
    label: 'Mistral (free Experiment plan)',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    signup: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    label: 'OpenRouter (:free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys',
    headers: { 'HTTP-Referer': 'https://github.com/esantos7616-tech/boss-ai-site', 'X-Title': 'Boss AI' },
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    keyEnv: 'GITHUB_TOKEN',
    signup: 'https://github.com/settings/tokens (fine-grained token with "Models: read")',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrl: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    keyEnv: 'CLOUDFLARE_API_TOKEN',
    requires: ['CLOUDFLARE_ACCOUNT_ID'],
    signup: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  ollama: {
    label: 'Ollama (local, offline)',
    baseUrl: (env) => (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '') + '/v1',
    keyEnv: null,
    requires: ['OLLAMA_URL'],
    signup: 'https://ollama.com/download, then: ollama pull llama3.2:3b',
  },
};

export class ProviderError extends Error {
  constructor(message, status = 0, retryAfterSec = 0) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function providerReady(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  if (p.keyEnv && !process.env[p.keyEnv]) return false;
  return (p.requires || []).every((k) => process.env[k]);
}

export function baseUrlOf(name) {
  const p = PROVIDERS[name];
  return typeof p.baseUrl === 'function' ? p.baseUrl(process.env) : p.baseUrl;
}

function headersOf(name) {
  const p = PROVIDERS[name];
  const h = { 'Content-Type': 'application/json', ...(p.headers || {}) };
  if (p.keyEnv) h.Authorization = 'Bearer ' + process.env[p.keyEnv];
  return h;
}

// Reasoning models sometimes inline their scratchpad; the user only needs the answer.
export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export async function chatCompletion(entry, messages, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await fetch(baseUrlOf(entry.provider) + '/chat/completions', {
      method: 'POST',
      headers: headersOf(entry.provider),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: entry.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        // entry.maxTokens is a floor: reasoning models need room to think before answering.
        max_tokens: Math.max(opts.maxTokens || 0, entry.maxTokens || 0) || 1200,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(`${entry.provider} ${res.status}: ${body.slice(0, 200)}`, res.status,
        Number(res.headers.get('retry-after')) || 0);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !stripThinking(content)) throw new ProviderError(`${entry.id}: empty response`);
    return stripThinking(content);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(err.name === 'AbortError' ? `${entry.id}: timed out` : `${entry.id}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
