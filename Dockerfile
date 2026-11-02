# Pinned to the Bun the repo is developed and tested with (`bun --version`); move it on deliberately.
FROM oven/bun:1.3.13-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
# The server writes nothing to disk (data lives in Postgres) except inside FOLDERS_ROOT, the folder
# the laptop kit mounts for folder collections (F22), so it runs as the image's unprivileged `bun`
# user; the app's files stay root-owned and read-only to it.
USER bun
EXPOSE 3000
# Migrations run at boot (idempotent), then the HTTP + WebSocket server.
CMD ["bun", "src/server.ts"]
