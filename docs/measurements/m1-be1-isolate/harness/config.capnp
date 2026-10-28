# workerd config for the m1-be1-isolate measurement (run.ts starts it).
#
# The same host Worker settings as images/isolate-host/config.capnp, serving
# bench-host.ts (loader.ts plus the /bench routes) built into dist/ by run.ts.
# run.ts overrides the socket address with --socket-addr. The vault is never
# reached while listing; it points at a closed local port.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "isolate-host", worker = .hostWorker),
    (name = "vault", external = (address = "127.0.0.1:9", http = (style = proxy))),
    (name = "internal", network = (allow = ["private", "public", "local"])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:0", http = (), service = "isolate-host"),
  ],
);

const hostWorker :Workerd.Worker = (
  modules = [
    (name = "bench-host.js", esModule = embed "dist/bench-host.js"),
    (name = "harbour-sandbox-bundle", text = embed "dist/sandbox.js"),
    (name = "harbour-pooled-sandbox-bundle", text = embed "dist/pooled-sandbox.js"),
    (name = "harbour-trivial-bundle", text = embed "dist/trivial-sandbox.js"),
    (name = "harbour-lazy-sandbox-bundle", text = embed "dist/lazy-sandbox.js"),
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
    (name = "VAULT_ISOLATE_KEY", text = "m1-be1-isolate-bench"),
  ],
  globalOutbound = "internal",
);
