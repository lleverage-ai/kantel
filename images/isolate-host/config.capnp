# workerd config for Kantel's self-hosted isolate host.
#
# One Worker (the host) with a workerLoader binding. The host gives each
# session its own Dynamic Worker, from a pre-loaded pool unless
# ISOLATE_POOL_SIZE=0, and points its globalOutbound at the vault proxy.
# workerd is "not a hardened sandbox": run this container under gVisor
# (KANTEL_ISOLATE_RUNTIME=runsc in deploy/compose) or a microVM in production.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "isolate-host", worker = .hostWorker),
    # The vault proxy, spoken to as an HTTP forward proxy: the request line
    # carries the full URL, so the proxy sees the real destination and makes
    # the TLS connection itself. Sandboxes reach nothing else.
    (name = "vault", external = (address = "vault-proxy:3128", http = (style = proxy))),
    # The host's own outbound traffic (MinIO). Never given to a sandbox.
    (name = "internal", network = (allow = ["private", "public", "local"])),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "isolate-host"),
  ],
);

const hostWorker :Workerd.Worker = (
  modules = [
    (name = "loader.js", esModule = embed "dist/loader.js"),
    (name = "kantel-sandbox-bundle", text = embed "dist/sandbox.js"),
  ],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "LOADER", workerLoader = (id = "harbour-sandboxes")),
    (name = "VAULT", service = "vault"),
    (name = "COMPATIBILITY_DATE", text = "2026-10-01"),
    (name = "S3_ENDPOINT", fromEnvironment = "S3_ENDPOINT"),
    (name = "S3_BUCKET", fromEnvironment = "S3_BUCKET"),
    (name = "S3_ACCESS_KEY", fromEnvironment = "S3_ACCESS_KEY"),
    (name = "S3_SECRET_KEY", fromEnvironment = "S3_SECRET_KEY"),
    (name = "VAULT_ISOLATE_KEY", fromEnvironment = "VAULT_ISOLATE_KEY"),
    # Pre-loaded isolates kept ready for new sessions (loader.ts). Unset: 4.
    # 0 loads one isolate per session on its first call, as in the spike.
    (name = "ISOLATE_POOL_SIZE", fromEnvironment = "ISOLATE_POOL_SIZE"),
  ],
  globalOutbound = "internal",
);
