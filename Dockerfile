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

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and config
COPY --from=builder /app/dist ./dist
COPY config ./config

# Create data directory for SQLite
RUN mkdir -p data

EXPOSE 3777

CMD ["node", "dist/index.js"]
