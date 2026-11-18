# ── 1. Build the React/Vite renderer ─────────────────────────────────────────
FROM node:24-alpine AS web

WORKDIR /app
# Electron is a dev-only dependency; skip its 100MB binary in the web image.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 2. Compile the TypeScript server ─────────────────────────────────────────
FROM node:24-alpine AS server

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY server ./server
COPY tsconfig.json ./
RUN npm run build:server
# Prune to production dependencies for the final image.
RUN npm prune --omit=dev

# ── 3. Runtime: static UI + harness engine bridge ────────────────────────────
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    FLUTTERFORGE_ALLOW_REMOTE=1 \
    FLUTTERFORGE_DATA_DIR=/data/.flutterforge

# Unprivileged user for the app; /data holds workspaces, previews and caches.
RUN addgroup -S flutterforge && adduser -S flutterforge -G flutterforge \
  && mkdir -p /data && chown -R flutterforge:flutterforge /data

COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist-server ./dist-server
COPY --from=web /app/dist ./dist
COPY package.json ./

# The harness engine (dsh) is optional at runtime: when it is not mounted the
# UI still loads and the browser-side agent remains available as a fallback.
# Mount a Linux DeepSeek Harness runtime and set DSH_BIN to enable it.
EXPOSE 8787
VOLUME ["/data"]

USER flutterforge

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
