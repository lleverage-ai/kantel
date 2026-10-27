# Harbour self-hosted session host (every host is also a gateway).
FROM oven/bun:1.3.14-alpine
WORKDIR /harbour/apps/selfhosted
COPY apps/selfhosted/package.json apps/selfhosted/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY spike/contracts /harbour/spike/contracts
# M0-BE1's tier table and router (type imports are erased at runtime).
COPY packages/contracts/src /harbour/packages/contracts/src
COPY packages/sandbox/src /harbour/packages/sandbox/src
COPY apps/selfhosted/sql ./sql
COPY apps/selfhosted/src ./src
EXPOSE 8080
CMD ["bun", "src/main.ts", "host"]
