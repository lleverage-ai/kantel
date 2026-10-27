# Harbour stub vault proxy. Dependencies installed with bun (the lockfile is
# bun's); the proxy itself runs on Node, whose HTTP server accepts proxy-style
# requests without a Host header (workerd sends those).
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY apps/vault-proxy/package.json apps/vault-proxy/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/vault-proxy/package.json ./
COPY apps/vault-proxy/src ./src
USER node
EXPOSE 3128
CMD ["node", "src/main.ts"]
