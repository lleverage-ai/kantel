# Bench image for the M0-BE2 seeding measurements.
# One image for both targets: plain Docker on a self-hosted node and a
# Cloudflare Container (durable_object scheduling policy).
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl zstd tar jq squashfs-tools squashfuse fuse-overlayfs fuse3 procps time \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@12.15.0 --activate \
 && npm install -g bun@1 \
 && git config --system safe.directory '*' \
 && git config --system advice.detachedHead false \
 && git config --system uploadpack.allowFilter true \
 && git config --system uploadpack.allowAnySHA1InWant true \
 && mkdir -p /workspace /cache

COPY bin/ /usr/local/bin/
WORKDIR /workspace
CMD ["sleep", "infinity"]
