# Kantel self-hosted image: the session hosts (`bun src/main.ts host`, every
# host is also the spike's gateway), the gateway (`bun src/gateway/main.ts`)
# and the console's static build, which the gateway serves.
#
# The workspace is installed with pnpm from the repo's lockfile, so the
# packages (@kantel/runtime, identity, workspace, audit, contracts) resolve as
# they do in CI; Bun then runs their TypeScript sources directly.
FROM node:24-bookworm-slim AS build
WORKDIR /harbour
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The lockfile names the patched dependencies (Pi Durable's partitioned tool rounds), whose patches pnpm reads.
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@kantel/selfhosted..." --filter "@kantel/console..."
RUN pnpm --filter @kantel/console build

FROM oven/bun:1.3.14-slim
COPY --from=build /harbour /harbour
WORKDIR /harbour/apps/selfhosted
EXPOSE 8080
CMD ["bun", "src/main.ts", "host"]
