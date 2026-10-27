# Harbour M0-CF1 container tier: the heavier tools the isolate tier cannot run.
FROM oven/bun:1.3-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 curl ca-certificates jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/harbour
COPY server.ts entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/opt/harbour/entrypoint.sh"]
