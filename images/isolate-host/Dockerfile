# Kantel isolate host: workerd (from npm) serving the loader Worker, which
# loads one Dynamic Worker per session with the workerLoader binding.
FROM oven/bun:1.3.14 AS build
WORKDIR /src
COPY images/isolate-host/package.json images/isolate-host/bun.lock ./
RUN bun install --frozen-lockfile
COPY images/isolate-host/build.ts ./
COPY images/isolate-host/src ./src
RUN bun run build.ts

# workerd's npm binary links against glibc.
FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& apt-get clean \
	&& useradd --uid 1000 --create-home workerd
# Security updates: the base image's own packages only get Debian's fixes here (a build from a warm cache or an old
# pull keeps them as they were). The daily build (.github/workflows/sandbox-image.yml) passes today's date, which
# re-runs this layer even with a warm cache.
ARG KANTEL_SECURITY_REFRESH=unset
RUN echo "security refresh $KANTEL_SECURITY_REFRESH" \
	&& apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get -y upgrade --no-install-recommends \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/node_modules/@cloudflare/workerd-linux-64/bin/workerd /usr/local/bin/workerd
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY images/isolate-host/config.capnp ./config.capnp
USER workerd
EXPOSE 8080
CMD ["workerd", "serve", "config.capnp", "--experimental"]
