FROM node:22.17.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22.17.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY --from=build /app/dist ./dist
COPY tools ./tools

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/scrapling-venv \
    && /opt/scrapling-venv/bin/pip install --no-cache-dir "scrapling[fetchers]" \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
       /opt/scrapling-venv/bin/python3 -c "from scrapling.cli import install; install([], standalone_mode=False)" \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
       /opt/scrapling-venv/bin/playwright install-deps 2>/dev/null || true \
    && rm -rf /root/.cache /tmp/* \
    && chmod -R a+rX /opt/scrapling-venv /opt/playwright-browsers

ENV SCRAPLING_VENV=/opt/scrapling-venv \
    PATH=/opt/scrapling-venv/bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
