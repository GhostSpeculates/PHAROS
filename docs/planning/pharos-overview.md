# Pharos — Local AI Router

> A self-hosted AI router that classifies requests and routes them to the best model based on complexity.

## Location
`~/PHAROS/`

## Architecture

Pharos is a local server that:
1. Receives prompts
2. Classifies complexity (1-10 scale)
3. Routes to the appropriate model tier

## Config (`pharos.yaml`)

| Setting | Value |
|---------|-------|
| Port | 3777 |
| Host | 0.0.0.0 |
| Body limit | 10 MB |
| Rate limit | 100/min (30/min for agents) |
| Self-test | enabled |

### Classifier Providers
| Provider | Model |
|----------|-------|
| Moonshot | kimi-latest |
| Groq | llama-3.3-70b-versatile |
| xAI | grok-3-mini-fast |
- Fallback tier: economical
- Timeout: 3000ms
- Cache: 100 entries, 30s TTL

### Model Tiers
| Tier | Score Range | Provider | Model |
|------|------------|----------|-------|
| Local | 1-3 | Ollama | qwen2.5:14b |
| (others defined in full config) | | | |

## Tech Stack
- Node.js server
- Docker support (Dockerfile + docker-compose.yml)
- YAML config

## Files
```
~/PHAROS/
├── config/           # Additional config
├── data/             # Runtime data
├── dist/             # Built output
├── pharos.yaml       # Main config
├── docker-compose.yml
├── Dockerfile
└── LAUNCH-CHECKLIST.md
```

---
See also: [[03-INFRASTRUCTURE/launchd-services]], [[05-PROJECTS/mirofish]]
