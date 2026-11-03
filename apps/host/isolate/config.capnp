# workerd config for kantel-host's isolate tier, inside the isolate VM (see src/host.ts).
#
# STORE and EGRESS are kantel-guest bridges to the host over vsock: the host's blob store for this VM's account,
# and the host's egress proxy (in HTTP proxy style, so it sees each request's real destination). A sandbox reaches
# neither: its only way out is its globalOutbound, the Egress entrypoint, which names it to the host.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "isolate", worker = .hostWorker),
    (name = "store", external = (address = "127.0.0.1:7001", http = ())),
    (name = "egress", external = (address = "127.0.0.1:7002", http = (style = proxy))),
    (name = "none", network = (allow = [])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8080", http = (), service = "isolate"),
  ],
);

const hostWorker :Workerd.Worker = (
  modules = [
    (name = "host.js", esModule = embed "dist/host.js"),
    (name = "kantel-sandbox-bundle", text = embed "dist/sandbox.js"),
  ],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "LOADER", workerLoader = (id = "kantel-isolates")),
    (name = "STORE", service = "store"),
    (name = "EGRESS", service = "egress"),
    (name = "COMPATIBILITY_DATE", text = "2026-10-01"),
  ],
  globalOutbound = "none",
);
