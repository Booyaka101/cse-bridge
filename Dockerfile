# syntax=docker/dockerfile:1
#
# cse-bridge — Google Custom Search JSON API wire format over your own SearXNG.
# Multi-stage: TypeScript is compiled in the builder, only dist/ + bin/ ship.

FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    SEARXNG_URL=http://searxng:8080 \
    PORT=8080 \
    HOST=0.0.0.0 \
    PROFILES_FILE=/app/profiles.yml

# No runtime dependencies: the bridge uses only the Node standard library.
COPY package.json ./
COPY bin ./bin
COPY profiles.yml ./profiles.yml
COPY --from=builder /build/dist ./dist

RUN chown -R node:node /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/cse-bridge.js"]

LABEL org.opencontainers.image.title="cse-bridge" \
      org.opencontainers.image.description="Self-hosted Google Custom Search JSON API replacement backed by SearXNG" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/Booyaka101/cse-bridge"
