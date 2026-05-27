-- Pharos Postgres schema (Slice B migration target)
-- Apply once per Supabase project via SQL editor.

-- ─── Users (wallet) ───
CREATE TABLE IF NOT EXISTS users (
    id              bigserial   PRIMARY KEY,
    email           text        UNIQUE NOT NULL,
    stripe_customer_id text,
    pharos_api_key_hash text    NOT NULL,
    balance_cents   bigint      NOT NULL DEFAULT 0,
    daily_cap_cents bigint,
    monthly_cap_cents bigint,
    role            text        NOT NULL DEFAULT 'user',
    org_id          bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    active          integer     NOT NULL DEFAULT 1,
    frozen          integer     NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(pharos_api_key_hash);

-- ─── Wallet ledger ───
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id              bigserial   PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users(id),
    txn_type        text        NOT NULL,
    amount_cents    bigint      NOT NULL,
    model           text,
    provider        text,
    modality        text,
    policy          text,
    tokens_in       bigint,
    tokens_out      bigint,
    request_id      text,
    stripe_event_id text,
    ts              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_ts ON wallet_ledger(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON wallet_ledger(request_id)
    WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_stripe_event ON wallet_ledger(stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency ON wallet_ledger(request_id, txn_type)
    WHERE request_id IS NOT NULL;

-- ─── Requests (tracking) ───
CREATE TABLE IF NOT EXISTS requests (
    id                          text        PRIMARY KEY,
    timestamp                   text        NOT NULL,
    tier                        text        NOT NULL,
    provider                    text        NOT NULL,
    model                       text        NOT NULL,
    classification_score        integer     NOT NULL,
    classification_type         text        NOT NULL,
    classification_latency_ms   integer     NOT NULL,
    classifier_provider         text        DEFAULT 'unknown',
    tokens_in                   integer     NOT NULL DEFAULT 0,
    tokens_out                  integer     NOT NULL DEFAULT 0,
    estimated_cost              double precision NOT NULL DEFAULT 0,
    baseline_cost               double precision NOT NULL DEFAULT 0,
    savings                     double precision NOT NULL DEFAULT 0,
    total_latency_ms            integer     NOT NULL DEFAULT 0,
    provider_latency_ms         integer,
    stream                      integer     NOT NULL DEFAULT 0,
    is_direct_route             integer     NOT NULL DEFAULT 0,
    status                      text        DEFAULT 'success',
    error_message               text,
    user_message_preview        text,
    debug_input                 text,
    debug_output                text,
    agent_id                    text,
    conversation_id             text,
    retry_count                 integer     DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_tier ON requests(tier);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_classifier_provider ON requests(classifier_provider);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_agent_id ON requests(agent_id);

-- ─── Model performance learning ───
CREATE TABLE IF NOT EXISTS model_performance (
    provider            text        NOT NULL,
    model               text        NOT NULL,
    task_type           text        NOT NULL,
    success_count       bigint      NOT NULL DEFAULT 0,
    error_count         bigint      NOT NULL DEFAULT 0,
    total_latency_ms    bigint      NOT NULL DEFAULT 0,
    last_updated        text        NOT NULL,
    PRIMARY KEY (provider, model, task_type)
);
