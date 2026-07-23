FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY node/package.json node/package-lock.json ./
RUN npm ci

COPY node/ ./
RUN npm run build

FROM debian:bookworm-slim AS singbox

ARG TARGETARCH
ARG SING_BOX_VERSION=1.13.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported sing-box architecture: $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/sing-box.tar.gz \
    && tar -xzf /tmp/sing-box.tar.gz -C /tmp \
    && mkdir -p /opt/sing-box \
    && cp "/tmp/sing-box-${SING_BOX_VERSION}-linux-${TARGETARCH}/sing-box" /opt/sing-box/sing-box \
    && chmod 0755 /opt/sing-box/sing-box

FROM node:22-bookworm-slim AS migration

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY node/package.json node/package-lock.json ./

ENTRYPOINT ["node"]
CMD ["build/src/cli/export-legacy-postgres-snapshot.js"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GROK2API_HOST=0.0.0.0 \
    GROK2API_PORT=40081 \
    GROK2API_DATA_DIR=/app/data-node \
    GROK2API_ACCOUNT_MODE=round_robin

WORKDIR /app

COPY node/package.json node/package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && mkdir -p /app/data-node \
    && chown -R node:node /app /ms-playwright

COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/public ./public
COPY --from=singbox /opt/sing-box/sing-box /opt/sing-box/sing-box

USER node

EXPOSE 40081

ENTRYPOINT ["node"]
CMD ["build/src/main.js"]
