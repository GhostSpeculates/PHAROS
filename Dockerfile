# ============================================
# PHAROS — Multi-stage Docker Build
# ============================================
# Build:  docker build -t pharos .
# Run:    docker run -p 3777:3777 --env-file .env pharos

# --- Stage 1: Build TypeScript ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: Production Image ---
FROM node:20-alpine
WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and config
COPY --from=builder /app/dist ./dist
COPY config ./config

# Create data directory for SQLite
RUN mkdir -p data

# Run as non-root user
RUN addgroup -g 1001 -S pharos && \
    adduser -S pharos -u 1001 -G pharos && \
    chown -R pharos:pharos /app
USER pharos

EXPOSE 3777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3777/health || exit 1

CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
