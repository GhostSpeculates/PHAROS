# Getting Started with Pharos

This guide walks you through setting up Pharos from scratch. You will have an intelligent LLM routing gateway running in under 5 minutes.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Setup](#quick-setup)
3. [Get Your API Keys](#get-your-api-keys)
4. [Configure Environment](#configure-environment)
5. [Test It Works](#test-it-works)
6. [What Each Tier Needs](#what-each-tier-needs)
7. [Configuration Reference](#configuration-reference)
8. [Deployment Options](#deployment-options)
9. [Connect Your App](#connect-your-app)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 20+** -- [Download from nodejs.org](https://nodejs.org/)
- **npm** (comes with Node.js) or **yarn**
- **At minimum:** A free Groq API key (powers the classifier and free tier)
- **Recommended:** Anthropic + OpenAI keys for premium and frontier tiers

Verify your Node.js version:

```bash
node --version  # Must be v20.0.0 or higher
```

---

## Quick Setup

```bash
# 1. Clone the repository
git clone https://github.com/GhostSpeculates/PHAROS.git
cd PHAROS

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env

# 4. Edit .env — add at least GROQ_API_KEY and PHAROS_API_KEY
#    (see "Get Your API Keys" below)

# 5. Start the development server
npm run dev
```

Pharos is now running at `http://localhost:3777`.

---

## Get Your API Keys

Pharos connects to multiple LLM providers. You only need the ones you want to use. At minimum, you need a **Groq** key (free).

| Provider | Console URL | What It Powers | Cost |
|----------|-------------|----------------|------|
| **Groq** (required) | [console.groq.com](https://console.groq.com) | Classifier + free tier (Llama 3.3 70B) | Free tier available |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) | Premium tier (Claude Sonnet), Frontier tier (Claude Opus) | Pay-per-use |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | All tiers (GPT-4o) | Pay-per-use |
| **Google** | [aistudio.google.com](https://aistudio.google.com) | Free tier (Gemini Flash) | Free tier available |
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com) | Economical tier | Pay-per-use |
| **Mistral** | [console.mistral.ai](https://console.mistral.ai) | Available but not in default tiers | Pay-per-use |
| **xAI** | [console.x.ai](https://console.x.ai) | Classifier fallback (Grok) | Pay-per-use |
| **Moonshot** | [platform.moonshot.cn](https://platform.moonshot.cn) | Classifier fallback + economical tier (Kimi K2) | Pay-per-use |

**Start with just Groq.** You can add more providers later by adding their keys to `.env` -- no restart needed for config changes, but you do need to restart the server.

---

## Configure Environment

Open `.env` in your editor and fill in your keys:

```env
# Server
PHAROS_PORT=3777
PHAROS_API_KEY=choose-a-secret-key-here    # Clients use this to authenticate

# Required: powers the classifier and free tier
GROQ_API_KEY=gsk_your_groq_key_here

# Recommended: enables premium/frontier tiers
ANTHROPIC_API_KEY=sk-ant-your_key_here
OPENAI_API_KEY=sk-your_key_here

# Optional: more providers = more routing options
GOOGLE_AI_API_KEY=your_google_key_here
DEEPSEEK_API_KEY=sk-your_deepseek_key_here
MOONSHOT_API_KEY=your_moonshot_key_here
XAI_API_KEY=your_xai_key_here
MISTRAL_API_KEY=your_mistral_key_here
```

The `PHAROS_API_KEY` is a password you choose. Clients must send it as a Bearer token to authenticate. If you leave it empty, authentication is disabled (open mode).

---

## Test It Works

### Health Check

```bash
curl http://localhost:3777/health
```

You should see a JSON response listing your providers and their health status:

```json
{
  "status": "ok",
  "service": "pharos",
  "version": "0.1.0",
  "providers": {
    "groq": { "available": true, "healthy": true }
  }
}
```

### Send a Test Request

```bash
curl -X POST http://localhost:3777/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PHAROS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

This sends a simple greeting. Pharos will classify it as low complexity (score 1-2) and route it to a free-tier model like Groq Llama 3.3.

### View the Dashboard

Open `http://localhost:3777` in your browser to see the live dashboard with provider health, request stats, and cost savings.

### Check Stats

```bash
curl -H "Authorization: Bearer YOUR_PHAROS_API_KEY" \
  http://localhost:3777/v1/stats
```

---

## What Each Tier Needs

Pharos routes queries based on complexity. Here is what API keys you need for each tier:

| Tier | Complexity Score | Required Keys | Models Used |
|------|-----------------|---------------|-------------|
| **Free** | 1-3 | `GROQ_API_KEY` | Groq Llama 3.3, Gemini Flash |
| **Economical** | 4-6 | `GROQ_API_KEY` | Groq Llama 3.3, Kimi K2, DeepSeek, GPT-4o |
| **Premium** | 7-8 | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Claude Sonnet, GPT-4o |
| **Frontier** | 9-10 | `ANTHROPIC_API_KEY` | Claude Opus, Claude Sonnet (fallback) |

**With only a Groq key**, Pharos will handle free and some economical tier queries. Premium and frontier requests will fail over through available providers -- if none are configured, they will fall back to the best available model.

**With Groq + Anthropic + OpenAI**, you have full coverage across all four tiers.

---

## Configuration Reference

Pharos uses a layered configuration system:

1. **Default config** -- `config/pharos.default.yaml` (shipped with Pharos, do not edit)
2. **User overrides** -- `pharos.yaml` in the project root (create this to customize)
3. **Environment variables** -- `.env` file (overrides everything)

### Customizing Tiers

Create a `pharos.yaml` in the project root to override tier configurations:

```yaml
# Example: make the classifier more conservative
# (more queries go to premium tier)
tiers:
  economical:
    scoreRange: [5, 6]    # Was [4, 6] — narrows economical range
  premium:
    scoreRange: [4, 8]    # Was [7, 8] — widens premium range
```

### Key Configuration Options

| Setting | File | Description |
|---------|------|-------------|
| Port | `.env` (`PHAROS_PORT`) | Server port (default: 3777) |
| API key | `.env` (`PHAROS_API_KEY`) | Auth token for clients |
| Tier score ranges | `pharos.yaml` | Which scores map to which tiers |
| Tier model pools | `pharos.yaml` | Which models are in each tier |
| Classifier chain | `pharos.yaml` | Which providers classify queries |
| Provider timeouts | `pharos.yaml` | Per-provider request timeout |
| Pricing | `pharos.yaml` | Per-model cost overrides |

See `config/pharos.default.yaml` for the full configuration reference with all available options and their defaults.

---

## Deployment Options

### Local Development

```bash
npm run dev    # Auto-restarts on file changes (tsx watch)
```

### Production (Direct)

```bash
npm run build   # Compile TypeScript to dist/
npm start       # Run the compiled build
```

### Docker

Pharos includes a Dockerfile for containerized deployment:

```bash
# Build and run with Docker Compose
docker compose up -d

# Or build manually
docker build -t pharos .
docker run -p 3777:3777 --env-file .env -v ./config:/app/config pharos
```

The Docker setup mounts your `config/` directory and persists the SQLite database in a named volume.

### VPS Deployment

For deploying to a VPS with systemd:

```bash
npm run build
bash scripts/deploy-vps.sh
```

The deploy script packages everything into a tarball, uploads it via SCP, and restarts the systemd service. See the script for details.

### Recommended Production Setup

1. Use systemd or Docker for process management (auto-restart on crash)
2. Set `PHAROS_API_KEY` to a strong secret
3. Bind to `127.0.0.1` (default) and put behind a reverse proxy if exposing to the internet
4. Set `NODE_ENV=production` for optimized logging

---

## Connect Your App

Pharos is a drop-in replacement for the OpenAI API. Any app that supports a custom `base_url` can use Pharos.

### Base URL

```
http://localhost:3777/v1
```

### API Key

Your `PHAROS_API_KEY` value, sent as a Bearer token.

### Model Name

Use `pharos-auto` for intelligent routing (recommended), or any specific model name to bypass the classifier.

### Example: Python (OpenAI SDK)

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

### Example: JavaScript/TypeScript (OpenAI SDK)

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

### Example: curl

```bash
curl -X POST http://localhost:3777/v1/chat/completions \
  -H "Authorization: Bearer your-pharos-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto",
    "messages": [{"role": "user", "content": "Explain quantum entanglement"}]
  }'
```

### For OpenClaw / Noir Integration

See [NOIR-INTEGRATION.md](./NOIR-INTEGRATION.md) for a detailed guide on connecting OpenClaw/Noir Discord bots to Pharos.

---

## Troubleshooting

### "Connection refused" on port 3777

- Make sure Pharos is running (`npm run dev` or `npm start`)
- Check that nothing else is using port 3777: `lsof -i :3777`
- Verify the port in `.env` matches your request URL

### "Unauthorized" (401) response

- Check that the `Authorization` header uses the format: `Bearer YOUR_PHAROS_API_KEY`
- Verify the key matches `PHAROS_API_KEY` in your `.env` file
- If `PHAROS_API_KEY` is empty in `.env`, auth is disabled (any key works)

### Provider shows "unhealthy" in /health

- Verify the API key for that provider is correct in `.env`
- The provider may be temporarily down -- Pharos will auto-recover after the cooldown period (default: 60s)
- Check Pharos logs for specific error messages

### Queries always go to the same tier

- Make sure `GROQ_API_KEY` is set (it powers the classifier)
- If the classifier fails, Pharos falls back to the premium tier for all queries
- Check logs for classifier errors: look for "classification failed" messages

### Build errors

- Verify Node.js 20+: `node --version`
- Clear and reinstall: `rm -rf node_modules && npm install`
- Check TypeScript: `npx tsc --noEmit`

---

## See Also

- [NOIR-INTEGRATION.md](./NOIR-INTEGRATION.md) -- Connecting OpenClaw/Noir Discord bots to Pharos
- [PRODUCT.md](./PRODUCT.md) -- Product definition, roadmap, and architecture details
- [config/pharos.default.yaml](./config/pharos.default.yaml) -- Full configuration reference
