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
COPY --from=build /src/node_modules/@cloudflare/workerd-linux-64/bin/workerd /usr/local/bin/workerd
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY images/isolate-host/config.capnp ./config.capnp
USER workerd
EXPOSE 8080
CMD ["workerd", "serve", "config.capnp", "--experimental"]
