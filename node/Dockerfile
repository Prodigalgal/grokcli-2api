FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY node/package.json node/package-lock.json ./
RUN npm ci

COPY node/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GROK2API_HOST=0.0.0.0 \
    GROK2API_PORT=40081 \
    GROK2API_DATA_DIR=/app/data-node \
    GROK2API_REQUIRE_API_KEY=auto \
    GROK2API_ACCOUNT_MODE=round_robin

WORKDIR /app

COPY node/package.json node/package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && mkdir -p /app/data-node \
    && chown -R node:node /app /ms-playwright

COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/public ./public

USER node

EXPOSE 40081

ENTRYPOINT ["node"]
CMD ["build/src/main.js"]
