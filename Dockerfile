# Obsidian MCP server — small, single-process Node image.
FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY server.js vault.js ./

# Mount points (bind-mounted at runtime via docker-compose).
#   /vault  -> your Obsidian vault (read-write)
#   /data   -> persistent audit log
RUN mkdir -p /vault /data

ENV NODE_ENV=production \
    PORT=8787 \
    VAULT_PATH=/vault \
    AUDIT_LOG_PATH=/data/audit.log

EXPOSE 8787

# Container-level health check hitting the unauthenticated /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "server.js"]
