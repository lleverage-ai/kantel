# Bench image plus the Sandbox SDK helper (needed by DirectoryBackup) and the small repo's seed
# cache (tvdavies/sal is private, so the container cannot fetch it). The public repos' caches are
# built inside a container with Internet access and saved as the "cache" snapshot instead: the
# registry timed out committing layers of 600 MB and more.
FROM harbour-m0-seed-bench:local
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY mirrors/sal.git/ /cache/mirrors/sal.git/
COPY deps/sal-* /cache/deps/
COPY sqsh/sal.sqsh /cache/sqsh/
