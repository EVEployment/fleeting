# ── Build stage (type-check + install) ───────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc --noEmit

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-alpine
RUN apk add --no-cache dumb-init curl
RUN addgroup -g 1001 -S peld && adduser -S peld -u 1001
WORKDIR /app

COPY --from=builder --chown=peld:peld /app ./

USER peld
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node_modules/.bin/tsx", "index.ts"]
