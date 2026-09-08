# ---- dependencies -----------------------------------------------------------
# Debian-based, not Alpine: baileys pulls in sharp, whose prebuilt binaries are
# glibc-only unless you install the musl variant by hand.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    AUTH_DIR=/app/auth
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.js ./
COPY src ./src
COPY public ./public

# The auth folder is the session. Keep it on a volume or you re-pair on every deploy.
RUN mkdir -p /app/auth && chown -R node:node /app
VOLUME ["/app/auth"]
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
