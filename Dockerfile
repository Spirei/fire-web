# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN test -s public/fire-assets/clownfish-family.png && npm run build

FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.12-slim-bookworm AS backend
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /platform
COPY platform/pyproject.toml platform/uv.lock ./
COPY platform/backend backend
RUN uv sync --frozen --no-dev --no-editable --extra futu

FROM python:3.12-slim-bookworm AS runtime
ARG PG_MAJOR=17
ARG FIRE_BUILD_SHA=""
RUN case "$PG_MAJOR" in 16|17|18) ;; *) exit 1 ;; esac \
    && apt-get update && apt-get install -y --no-install-recommends libstdc++6 libcairo2 ca-certificates curl gnupg \
    && curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/postgresql.asc \
    && gpg --show-keys --with-colons /usr/share/keyrings/postgresql.asc | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:' \
    && echo 'deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends "postgresql-client-$PG_MAJOR" \
    && apt-get purge -y --auto-remove curl gnupg && rm -rf /var/lib/apt/lists/*
ENV ALCOR_PG_TOOLS_DIR=/usr/lib/postgresql/${PG_MAJOR}/bin
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /app
COPY --from=web /app/node_modules node_modules
COPY --from=web /app/.next .next
COPY --from=web /app/public public
COPY --from=web /app/public/uploads resource-default
COPY --from=web /app/package.json package.json
COPY --from=web /app/next.config.mjs next.config.mjs
COPY --from=web /app/scripts scripts
COPY --from=web /app/contracts contracts
COPY --from=backend /platform/.venv /platform/.venv
COPY platform/pyproject.toml platform/uv.lock platform/
COPY platform/backend platform/backend
COPY platform/migrations platform/migrations
COPY platform/contracts platform/contracts
RUN groupadd -g 1000 fire && useradd -u 1000 -g fire -M fire && mkdir -p /app/run /app/public/uploads /app/.next/cache && chown -R fire:fire /app/run /app/public/uploads /app/.next/cache
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FIRE_PYTHON=/platform/.venv/bin/python TMPDIR=/app/run FIRE_BUILD_SHA=${FIRE_BUILD_SHA}
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=6s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
EXPOSE 3000
CMD ["npm", "start"]
