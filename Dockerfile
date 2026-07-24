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

FROM python:3.12-slim-bookworm AS registration-worker

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app:/app/grok-build-auth \
    HOME=/root \
    TZ=Asia/Shanghai \
    GROK2API_REGISTRATION_HOST=127.0.0.1 \
    GROK2API_REGISTRATION_PORT=18070 \
    GROK2API_CAPTCHA_PROVIDER=local \
    GROK2API_LOCAL_SOLVER_URL=http://127.0.0.1:5072 \
    TURNSTILE_HOST=127.0.0.1 \
    TURNSTILE_PORT=5072 \
    TURNSTILE_THREAD=1 \
    TURNSTILE_BROWSER_TYPE=camoufox \
    TURNSTILE_LAZY=1 \
    TURNSTILE_IDLE_SEC=180

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl fonts-liberation fonts-noto-color-emoji \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
        libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
        libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libxss1 libxtst6 \
        tzdata xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
COPY turnstile-solver/requirements.txt /app/turnstile-requirements.txt
RUN python -m pip install --no-cache-dir -U pip setuptools wheel \
    && python -m pip install --no-cache-dir -r /app/requirements.txt \
    && python -m pip install --no-cache-dir -r /app/turnstile-requirements.txt \
    && python -m camoufox fetch

COPY grok-build-auth /app/grok-build-auth
COPY grok2api /app/grok2api
COPY scripts /app/scripts
COPY turnstile-solver /app/turnstile-solver

RUN chmod +x /app/scripts/registration-worker-entrypoint.sh \
    && mkdir -p /app/turnstile-solver/logs /app/turnstile-solver/keys \
    && python -c "from scripts.registration_service import health; assert health()['ok']"

EXPOSE 18070

ENTRYPOINT ["/app/scripts/registration-worker-entrypoint.sh"]
