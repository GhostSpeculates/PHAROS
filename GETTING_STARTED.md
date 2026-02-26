# Getting Started with Pharos

Pharos is an intelligent LLM routing gateway. It classifies each query's complexity in real-time and routes it to the cheapest model that can handle it well. This guide covers local setup through production deployment.

---

## 1. Prerequisites

- **Node.js 20+** -- [nodejs.org](https://nodejs.org/)
- **At least one API key** -- Groq is the minimum (free, powers the classifier and free-tier routing)

```bash
node --version  # Must be v20.0.0 or higher
```

### Provider Signup Links

| Provider | Signup | Role |
|----------|--------|------|
| **Groq** (required) | https://console.groq.com | Classifier + free tier |
| **Google AI** | https://aistudio.google.com/apikey | Free tier (Gemini Flash) |
| **Anthropic** | https://console.anthropic.com | Premium + frontier tiers |
| **OpenAI** | https://platform.openai.com/api-keys | All tiers (GPT-4o) |
| **DeepSeek** | https://platform.deepseek.com | Economical tier |
| **Mistral** | https://console.mistral.ai | Available, not in default tiers |
| **xAI** | https://console.x.ai | Classifier fallback |
| **Moonshot** | https://platform.moonshot.ai | Classifier fallback + economical tier |

---

## 2. Installation

```bash
git clone https://github.com/GhostSpeculates/PHAROS.git
cd PHAROS
npm install
```

---

## 3. Configuration

Pharos uses layered config: `config/pharos.default.yaml` (defaults) -> `pharos.yaml` (your overrides) -> `.env` (secrets). Only set what you want to change.

### Setting Up .env

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# --- Server ---
PHAROS_PORT=3777                    # Port to listen on
PHAROS_HOST=127.0.0.1              # Bind address (localhost-only by default)
PHAROS_API_KEY=your-secret-here    # Clients authenticate with this Bearer token
PHAROS_LOG_LEVEL=info              # debug, info, warn, error

# --- Alerts (optional) ---
PHAROS_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# --- CORS (optional) ---
PHAROS_CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# --- Provider API Keys ---
GROQ_API_KEY=gsk_...              # REQUIRED
GOOGLE_AI_API_KEY=                # Recommended
ANTHROPIC_API_KEY=                # Optional
OPENAI_API_KEY=                   # Optional
DEEPSEEK_API_KEY=                 # Optional
MISTRAL_API_KEY=                  # Optional
XAI_API_KEY=                      # Optional
MOONSHOT_API_KEY=                 # Optional
```

### Customizing pharos.yaml

Create `pharos.yaml` in the project root. Only include keys you want to override.

```yaml
# Adjust tier score ranges
tiers:
  economical:
    scoreRange: [5, 6]      # Default [4, 6]
  premium:
    scoreRange: [4, 8]      # Default [7, 8]

# Adjust provider timeouts
providers:
  anthropic:
    timeoutMs: 45000        # Default 30000
    healthCooldownMs: 120000

# Change classifier chain
classifier:
  providers:
    - provider: moonshot
      model: kimi-latest
    - provider: groq
      model: llama-3.3-70b-versatile
    - provider: xai
      model: grok-3-mini-fast
  fallbackTier: economical
  timeoutMs: 5000
```

### Default Tier Routing

| Tier | Score | Models | Min Keys Needed |
|------|-------|--------|-----------------|
| Free | 1-3 | Groq Llama 3.3, Gemini Flash | `GROQ_API_KEY` |
| Economical | 4-6 | Groq Llama 3.3, Kimi Latest, DeepSeek, GPT-4o | `GROQ_API_KEY` |
| Premium | 7-8 | Claude Sonnet, GPT-4o | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| Frontier | 9-10 | Claude Opus, Claude Sonnet, GPT-4o | `ANTHROPIC_API_KEY` |

With only Groq, free and some economical queries work. Add Anthropic + OpenAI for full coverage.

---

## 4. Running Locally

```bash
npm run dev      # Development mode (auto-restart on changes)
```

Or for production:

```bash
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled build
```

Pharos starts at `http://localhost:3777`.

---

## 5. Verifying It Works

### Health Check

```bash
curl http://localhost:3777/health
```

```json
{
  "status": "ok",
  "service": "pharos",
  "providers": {
    "groq": { "available": true, "healthy": true }
  }
}
```

### Sample Chat Completion

```bash
curl -X POST http://localhost:3777/v1/chat/completions \
  -H "Authorization: Bearer your-secret-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto",
    "messages": [{"role": "user", "content": "What is 2 + 2?"}]
  }'
```

A simple question scores low (1-2) and routes to the free tier. The response follows OpenAI's format with additional `X-Pharos-*` headers showing tier, model, score, and cost.

### Dashboard

Open `http://localhost:3777` in your browser. Auto-refreshes every 30 seconds. Shows provider health, request counts, cost savings, and recent requests.

### Stats

```bash
curl -H "Authorization: Bearer your-secret-here" http://localhost:3777/v1/stats
```

---

## 6. Deploying to a VPS

### Deploy Script

The included script packages everything, uploads via SCP, and configures systemd.

```bash
# 1. Edit scripts/deploy-vps.sh -- set VPS_HOST, VPS_DIR, PORT
# 2. Ensure .env exists locally with all keys
# 3. Build and deploy:
npm run build
bash scripts/deploy-vps.sh
```

Packages: `dist/`, `config/`, `package.json`, `package-lock.json`, `.env`.

### Systemd Service File

The deploy script creates this automatically. For manual setup:

```ini
[Unit]
Description=Pharos - Intelligent LLM Routing Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/pharos
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/root/pharos/.env
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pharos
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/root/pharos
MemoryMax=2G
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp pharos.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable pharos && sudo systemctl start pharos
sudo systemctl status pharos
journalctl -u pharos -f   # Follow logs
```

### Security

- **Firewall:** `sudo ufw allow ssh && sudo ufw enable` -- do not expose port 3777 directly
- **Binding:** Pharos binds to `127.0.0.1` by default. Put it behind Nginx or Caddy for TLS.
- **Reverse proxy:** Forward to `http://127.0.0.1:3777`, set `proxy_buffering off` for SSE streaming support
- **Rate limiting:** 100 req/min per IP built-in via `@fastify/rate-limit`

---

## 7. Connecting Your App

Pharos is a drop-in replacement for the OpenAI API. Any app that supports a custom base URL can use it.

- **Base URL:** `http://localhost:3777/v1` (or your VPS address)
- **API Key:** Your `PHAROS_API_KEY` value
- **Model:** `pharos-auto` for intelligent routing, or any specific model name to bypass the classifier

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3777/v1",
    api_key="your-pharos-api-key"
)

response = client.chat.completions.create(
    model="pharos-auto",
    messages=[{"role": "user", "content": "Explain quantum entanglement"}]
)
print(response.choices[0].message.content)
```

### JavaScript / TypeScript (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3777/v1',
  apiKey: 'your-pharos-api-key',
});

const response = await client.chat.completions.create({
  model: 'pharos-auto',
  messages: [{ role: 'user', content: 'Explain quantum entanglement' }],
});
console.log(response.choices[0].message.content);
```

### curl (with streaming)

```bash
curl -X POST http://localhost:3777/v1/chat/completions \
  -H "Authorization: Bearer your-pharos-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto",
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku"}]
  }'
```

### Available Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Live HTML dashboard |
| `POST` | `/v1/chat/completions` | Main routing endpoint (OpenAI-compatible) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/stats` | Cost tracking and savings |
| `GET` | `/v1/stats/recent` | Last 25 requests |
| `GET` | `/health` | Health check with provider status |

---

## 8. Troubleshooting

### "Connection refused" on port 3777

- Confirm Pharos is running: `npm run dev` or `npm start`
- Check port conflict: `lsof -i :3777`
- Verify `PHAROS_PORT` in `.env` matches your request URL

### "Unauthorized" (401)

- Header must be exactly: `Authorization: Bearer <your-PHAROS_API_KEY>`
- If `PHAROS_API_KEY` is empty in `.env`, auth is disabled

### Provider returns 401

- API key is invalid or expired. Regenerate at the provider's console.
- Some providers require billing setup before the key works.

### Provider shows "unhealthy"

- Check the API key in `.env`
- Unhealthy = 3 consecutive errors. Auto-recovers after cooldown (default 60s).
- Check logs for specifics: `journalctl -u pharos -n 50`

### Queries always route to the same tier

- Classifier needs `MOONSHOT_API_KEY`. Without it, falls back to Groq, then xAI, then static score.
- Failover chain: Moonshot -> Groq -> xAI -> static economical score.
- Check logs for "classification failed" messages.

### Request timeouts

- Default timeout is 30s. Override per-provider in `pharos.yaml`:
  ```yaml
  providers:
    anthropic:
      timeoutMs: 60000
  ```
- Requests over 100K tokens trigger context window filtering, skipping undersized providers.

### Build errors

- Verify Node.js 20+: `node --version`
- Clean install: `rm -rf node_modules && npm install`
- Type check: `npx tsc --noEmit`

### Systemd service won't start

- Logs: `journalctl -u pharos -n 50 --no-pager`
- Verify `.env` exists at the `EnvironmentFile` path
- Verify `dist/index.js` exists (run `npm run build`)
- Check permissions on the working directory

---

## Further Reading

- `config/pharos.default.yaml` -- Full configuration reference
- `NOIR-INTEGRATION.md` -- Connecting OpenClaw/Noir Discord bots
- `PRODUCT.md` -- Product definition and roadmap
