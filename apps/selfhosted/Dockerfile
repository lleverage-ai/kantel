# Harbour self-hosted session host (every host is also a gateway).
FROM oven/bun:1.3.14-alpine
WORKDIR /harbour/apps/selfhosted
COPY apps/selfhosted/package.json apps/selfhosted/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY spike/contracts /harbour/spike/contracts
COPY apps/selfhosted/sql ./sql
COPY apps/selfhosted/src ./src
EXPOSE 8080
CMD ["bun", "src/main.ts", "host"]
