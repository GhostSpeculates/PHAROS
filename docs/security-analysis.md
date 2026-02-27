# Pharos Security Analysis & Hardening Roadmap

> **Addendum to Competitive Research Report** | February 23, 2026

---

## Your Concern — Answered Directly

> *"How good will we be at having heightened security for when hackers want to infiltrate our self-hosted tool and potentially create massive disruption and costs across multiple users' accounts?"*

**The short answer: being self-hosted is actually your biggest security advantage.** Here's why, and what we need to build to make it ironclad.

---

## 1. Why Self-Hosted = More Secure (Not Less)

| Threat | Managed Service (Martian/OpenRouter) | Self-Hosted (Pharos) |
|--------|-------------------------------------|---------------------|
| **Hack one, hack everyone** | ✅ One breach = ALL users compromised | ❌ Each instance is isolated — breaching one user's Pharos affects only them |
| **API keys in transit** | Keys sent to 3rd party servers | Keys never leave your VPS |
| **Data exposure** | Your prompts flow through their infra | Your prompts stay on YOUR machine |
| **Supply chain attack** | You trust THEIR dependencies | You audit YOUR dependencies |
| **Single point of failure** | Service goes down = all users down | Your instance is independent |

> [!IMPORTANT]
> **The "massive disruption across multiple users" scenario you're worried about is actually the Achilles' heel of managed services like Martian and OpenRouter — NOT self-hosted tools.** When OpenRouter gets breached, every user's keys are exposed. When one Pharos instance gets breached, only that one operator is affected. This is called **blast radius isolation** and it's a fundamental security architecture advantage.

---

## 2. Current Pharos Security Posture — What's Already In Place

### ✅ Already Hardened (Phase 1)

| Security Layer | Implementation | Status |
|---------------|----------------|--------|
| **API Authentication** | Bearer token auth via `auth.ts` | ✅ Working |
| **Rate Limiting** | 100 requests/minute/IP via `@fastify/rate-limit` | ✅ Working |
| **Network Isolation** | Bound to `127.0.0.1` (localhost only) | ✅ Working |
| **Firewall** | UFW — SSH only exposed | ✅ Working |
| **SSH Security** | Key-only auth, password disabled | ✅ Working |
| **CORS Control** | Configurable origins via env var | ✅ Working |
| **Input Validation** | Zod schema validation on all requests | ✅ Working |
| **Body Size Limit** | 10MB max request body | ✅ Working |
| **Graceful Shutdown** | 15s drain timeout, dead socket detection | ✅ Working |
| **Error Isolation** | `unhandledRejection` / `uncaughtException` handlers | ✅ Working |

> [!NOTE]
> **This is already more security than LiteLLM ships with out of the box.** LiteLLM has had CVEs for API key leaks through logging (CVE-2024-9606), error handling (CVE-2025-11203), and health endpoints. Pharos has none of these issues.

---

## 3. Threat Model — What Could Go Wrong

### 🔴 Critical Threats (Must Address)

| # | Threat | Attack Vector | Impact | Priority |
|---|--------|--------------|--------|----------|
| 1 | **Skeleton Key Problem** | Pharos holds keys to Anthropic, OpenAI, Google, etc. Breach = access to ALL providers | An attacker could burn thousands in API costs | **P0** |
| 2 | **API Key in .env file** | If VPS root is compromised, plain-text `.env` file exposes all provider keys | Full provider access | **P0** |
| 3 | **Brute-force Pharos API key** | Attacker guesses or steals the single Pharos bearer token | Unlimited routing through your providers | **P1** |

### 🟡 Medium Threats (Should Address)

| # | Threat | Attack Vector | Impact |
|---|--------|--------------|--------|
| 4 | **Prompt injection via routing** | Malicious prompt designed to trick classifier into scoring high → burns expensive Opus tokens | Cost manipulation |
| 5 | **Log exfiltration** | If dashboard is exposed, request logs may contain sensitive prompt data | Data leak |
| 6 | **Dependency supply chain** | Malicious npm package update could inject backdoor | Full system compromise |
| 7 | **Denial of service** | Flood requests to exhaust rate limits or provider quotas | Service disruption |

### 🟢 Low Threats (Good to Address)

| # | Threat | Attack Vector | Impact |
|---|--------|--------------|--------|
| 8 | **Stale dependencies** | Known CVEs in outdated packages | Varies |
| 9 | **SQLite injection** | Malicious data in tracking store queries | Data corruption |
| 10 | **Dashboard CSRF** | If dashboard exposed externally, cross-site request forgery | Configuration tampering |

---

## 4. Security Hardening Roadmap

### Phase 2 Security (Next Up)

| Feature | What It Does | Difficulty |
|---------|-------------|-----------|
| **Encrypted API key storage** | Encrypt `.env` provider keys at rest, decrypt only in memory | Medium |
| **Per-user API keys with quotas** | Multiple Pharos API keys, each with spend limits and rate caps | Medium |
| **Cost ceiling / kill switch** | Auto-disable routing if daily/monthly spend exceeds threshold | Easy |
| **Request signing** | HMAC-signed requests to prevent replay attacks | Medium |
| **Input sanitization layer** | Strip known prompt injection patterns before classification | Easy |
| **Audit logging** | Immutable log of all auth attempts, key usage, config changes | Easy |

### Phase 3 Security (Dashboard)

| Feature | What It Does | Difficulty |
|---------|-------------|-----------|
| **Dashboard authentication** | Login required for web dashboard (not just API) | Easy |
| **Sensitive data redaction** | Auto-mask PII, API keys, and secrets in dashboard request logs | Medium |
| **IP allowlisting** | Restrict Pharos API access to specific IP ranges | Easy |
| **Security alerts** | Notify operator on unusual patterns (cost spike, auth failures, etc.) | Medium |

### Phase 4 Security (Production-Grade)

| Feature | What It Does | Difficulty |
|---------|-------------|-----------|
| **Secret rotation** | Automated provider API key rotation with zero downtime | Hard |
| **Dependency scanning** | Automated CVE scanning of npm dependencies in CI/CD | Easy |
| **Penetration testing guide** | Document how to pen-test your own Pharos instance | Medium |
| **OWASP LLM Top 10 compliance** | Systematic check against all 10 categories | Medium |
| **Signed releases** | GPG-signed Docker images and npm packages | Medium |

---

## 5. The Bottom Line

```
┌──────────────────────────────────────────────────────────────┐
│                    PHAROS SECURITY MODEL                     │
│                                                              │
│  Layer 1: Network      → Firewall + localhost binding        │
│  Layer 2: Transport    → HTTPS/TLS (via reverse proxy)       │
│  Layer 3: Auth         → Bearer token + rate limiting        │
│  Layer 4: Validation   → Zod schema + body size limits       │
│  Layer 5: Isolation    → Self-hosted = blast radius of 1     │
│                                                              │
│  COMING:                                                     │
│  Layer 6: Encryption   → API keys encrypted at rest          │
│  Layer 7: Quotas       → Per-key spend limits + kill switch  │
│  Layer 8: Monitoring   → Anomaly detection + security alerts │
│  Layer 9: Supply Chain → Dependency scanning + signed builds │
└──────────────────────────────────────────────────────────────┘
```

### Pharos Security vs Competitors

| Feature | Pharos (Current) | Pharos (Roadmap) | LiteLLM | OpenRouter | Martian |
|---------|-----------------|-----------------|---------|-----------|---------|
| Self-hosted (blast radius isolation) | ✅ | ✅ | ✅ | ❌ | ❌ |
| API authentication | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rate limiting | ✅ | ✅ | ✅ | ✅ | ✅ |
| Network isolation (localhost) | ✅ | ✅ | ❌ | N/A | N/A |
| Known CVEs | **0** | **0** | Multiple | Unknown | Unknown |
| Per-user spend limits | ❌ | ✅ | ✅ | ❌ | ✅ |
| Encrypted key storage | ❌ | ✅ | ❌ | N/A | N/A |
| Cost kill switch | ❌ | ✅ | ❌ | ❌ | ❌ |
| Input sanitization | ❌ | ✅ | ❌ | ❌ | ❌ |
| Signed releases | ❌ | ✅ | ❌ | N/A | N/A |

> [!TIP]
> **The single most impactful security feature to add next is the cost ceiling / kill switch.** If an attacker somehow gets through, the maximum damage they can do is capped at whatever daily limit the operator sets. Example: max $10/day → worst case, attacker burns $10. This turns a catastrophic risk into a bounded, manageable one.
