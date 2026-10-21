# Boss AI

Boss AI is a team of **30 free LLMs**. A supervisor model coordinates specialist agents that help you learn to invest, trade smarter, and start businesses.

- `index.html` is the website/app (chat, voice, team panel). Host it anywhere, e.g. GitHub Pages.
- `server/` is the backend that runs on your Raspberry Pi (or any computer with Node 18+). It has no npm dependencies.

## How it works

```
You ──► SUPERVISOR (the model with the lowest measured hallucination rate)
          │ 1. PLAN: picks the best specialist agents, may create a new one
          ▼
        AGENTS run in parallel, each on a different worker model
        (Market Analyst on DeepSeek, Risk Manager on Llama, ...)
          │ get live market data + what Boss remembers about you
          │ may propose new sub-agents
          ▼
        SUPERVISOR  2. VERIFY: cross-checks every report against the data
                       and against each other, drops unsupported claims
                    3. ANSWERS you, grades each agent, approves/rejects
                       proposed agents, saves facts about you
          ▼
        LEARNING: your 👍/👎 + the supervisor's grades update scores,
        so better models and agents get picked more often
```

**The 30 models** (`server/models.json`) span 8 free providers and 11 model families: Gemini, Llama, GPT-OSS, Qwen, Kimi, Mistral, DeepSeek, Gemma, GLM, GPT-4.1/4o-mini, Phi, plus 2 offline models. Using different families matters because models from different labs make different mistakes, so cross-checking them catches more errors.

**Self-expanding**
- Worker models propose new specialist agents while they work. The supervisor approves only the useful ones. Each new agent is "owned" by the model that proposed it. It starts with 12 optional starter agents, and the team is capped at 150.
- New free models published on OpenRouter are discovered automatically and join the worker pool.

**Adaptive learning**
- Every model and agent keeps a win/loss record. Routing uses Thompson sampling, so proven performers get picked more often and newcomers still get a chance.
- Spawned agents with consistently bad ratings are retired automatically.
- Long-term memory: Boss remembers your goals, budget and risk tolerance, plus lessons from answers you rated 👎.
- Rate-limited or retired models are benched automatically, and the next-best model takes over.

**Jarvis features**
- **Daily briefing:** every morning at `BRIEFING_TIME`, the team prepares a market recap, your watchlist moves with headlines, one business task for the day, and one thing to learn. It's waiting when you open the site, and it's read aloud if voice replies are on. Tap ☀️ to get one any time.
- **Live web search:** the supervisor decides when a question needs current information and searches the web and news. Answers cite their sources as [1], [2], and the sources are clickable. This works with no key; a free Tavily or Brave key gives better results.
- **Watchlist by voice or text:** say "add NVDA to my watchlist", or manage it in the 👥 Team panel.
- **Nothing about the team is fixed:** starter agents are optional (`STARTER_AGENTS=0` starts empty, and the supervisor hires everyone). They're editable in `server/agents.seed.json`. The supervisor rewrites the instructions of agents that do badly, and any agent, including starters, is retired if its record stays poor. You can also retire agents yourself in the Team panel.

**Least-hallucination supervisor.** `npm run benchmark` asks every model 12 questions. Half have one checkable answer. The other half are traps (fake companies, future dates, false premises) where the only honest answer is "that doesn't exist" or "I don't know". The model with the lowest measured error rate becomes the supervisor. Until you run the benchmark, a sensible default is used (Gemini 2.5 Flash).

**Grounded in real numbers.** When you mention a stock (`$TSLA`, `NVDA`, or "apple"), Boss pulls a year of free price data and computes returns, moving averages, 52-week range, volatility and drawdown in code. Agents may only quote those numbers.

## Setup (about 15 minutes)

1. **Get free API keys.** Each one unlocks more models. You need at least one; more keys give more models and fewer rate limits.

   | Provider | Models | Get a key |
   |---|---|---|
   | Google AI Studio | 3 | https://aistudio.google.com/apikey |
   | Groq | 7 | https://console.groq.com/keys |
   | OpenRouter | 8 + auto-discovered | https://openrouter.ai/keys |
   | Mistral (Experiment plan) | 3 | https://console.mistral.ai/api-keys |
   | Cerebras | 2 | https://cloud.cerebras.ai |
   | GitHub Models | 3 | https://github.com/settings/tokens (fine-grained, "Models: read") |
   | Cloudflare Workers AI | 2 | https://dash.cloudflare.com/profile/api-tokens |
   | Ollama (local, offline) | 2 | https://ollama.com, then `ollama pull llama3.2:3b && ollama pull qwen2.5:3b` |

2. **Run the backend on the Pi:**
   ```bash
   cd server
   cp .env.example .env      # paste your keys, and set BOSS_ACCESS_KEY to a long random string
   npm start
   npm run benchmark         # optional but recommended: measures hallucination, picks the supervisor
   ```

3. **Expose it** with a Cloudflare tunnel: `cloudflared tunnel --url http://localhost:3000`.

4. **Open the site.** Use GitHub Pages, or open `http://<pi>:3000` because the server also serves the page. Tap ⚙️, paste the tunnel URL and your access key, then Save. Tap 👥 to see the team, the supervisor, scores, and what Boss remembers.

Run the tests with `cd server && npm test`.

### API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ai-chat` | `{message, history}` returns `{message, meta}` |
| POST | `/api/feedback` | `{interactionId, rating: 1 or -1, comment?}` |
| GET | `/api/team` | Models, agents, scores, memory |
| GET | `/api/health` | Connection status (no key needed) |
| POST | `/api/benchmark` | Re-run the hallucination benchmark in the background |
| POST | `/api/memory/forget` | Erase long-term memory |
| GET | `/api/briefing/latest` | Latest daily briefing |
| POST | `/api/briefing` | Make a briefing now |
| GET/POST | `/api/watchlist` | Read, or `{add:[...], remove:[...]}` |
| DELETE | `/api/agents/:id` | Retire an agent |

All endpoints except `/api/health` require the `X-Boss-Key` header when `BOSS_ACCESS_KEY` is set.

## Honest limits

- **"Learning" means learning around the models, not retraining them.** Free APIs don't let you change model weights. Boss gets better by routing to what works, creating and retiring agents, and remembering you. Training your own model would need paid GPUs.
- **Free tiers have rate limits.** Each question uses about 2 + `WORKERS_PER_QUERY` calls (6 by default). With several providers connected, that's plenty for personal use. Model names on free tiers change, which is why Boss benches dead models and auto-discovers new ones. Edit `models.json` any time.
- **No AI can reliably pick winning stocks.** Boss is built to make you a better-informed investor: it shows real data, explains risk, and argues both sides. It is not a signal service, and it can be wrong.

## Before you sell it

- **Free API terms.** Several free tiers are for personal or prototype use, and some (e.g. Google AI Studio's free tier) may use your prompts to improve their models. A paid product should switch to paid keys or let each user bring their own free keys. The code already supports both.
- **Financial regulation.** Selling *personalized* investment advice can require registration (in the US, as an investment adviser with the SEC or your state). Positioning it as an educational tool, with clear disclaimers (already in the UI), is the common route. Talk to a lawyer before charging money.
- **App stores.** The site is mobile-first. Next steps: add a PWA manifest and service worker, then wrap it with Capacitor (iOS and Android) or a Trusted Web Activity (Google Play). User accounts and a hosted backend would replace the single-user Pi.
