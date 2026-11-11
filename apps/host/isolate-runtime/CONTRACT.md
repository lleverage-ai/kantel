# Contract: Kantel's deno_core isolate runtime (shared by all workstreams)

Decided 11 Nov 2026: Kantel's isolate runtime moves from workerd to deno_core. This file fixes the interface
between the workstreams so they can run in parallel. Change it only by telling the parent agent.

## The binary
- Crate: `apps/host/isolate-runtime` (Rust, edition 2024, `deno_core = "0.412"`), binary `kantel-isolate`.
- `kantel-isolate serve --listen 127.0.0.1:8080 --store http://127.0.0.1:7001 --egress http://127.0.0.1:7002 --assets /opt/kantel-isolate`
  Optional flags (all have defaults): `--pool <n>` (pre-loaded shell isolates), `--node-pool <n>`, `--python-pool <n>`,
  `--cpu-ms <ms>` (per command, default 120000 like Lleverage's), `--max-sandboxes <n>`, `--max-runs <n>` (concurrent
  node/python runs), `--log-format json|text`. Every flag also reads `KANTEL_ISOLATE_<FLAG>` (upper snake case).
- `kantel-isolate version` prints `{"version": "...", "v8": "...", "v8Sandbox": true|false}` as JSON.
- `--assets` is a directory made by `apps/host/isolate-runtime/build-assets.sh <out-dir>`: the guest bundles (shell,
  node, python), the pinned Pyodide distribution (checked by SHA-256) and the Pyodide memory snapshot.
- Runs as an unprivileged user in the isolate VM (systemd unit `kantel-isolate.service`, replacing
  `kantel-workerd.service`), or as a native process per account on a host without KVM (kantel-host's `startNative`).
- Talks only to `--store` (the host's blob store bridge: `GET /blobs/<sha>`, `PUT /blobs` → `{"sha"}`) and `--egress`
  (the host's egress proxy bridge, proxy-style HTTP requests carrying `kantel-isolate-sandbox: <sandboxId>`; the
  guest's own `kantel-*` headers are dropped first). No other network, no filesystem outside `--assets` (read-only)
  and its own temporary directory.

## HTTP API (what kantel-host's apps/host/internal/isolate/isolate.go calls; same shapes as apps/host/isolate/src/host.ts)
- `GET /healthz` → `{"ok": true, "want": n, "idle": n, "sessions": n, "runtime": "deno_core", "version": "...",
  "capabilities": {"javascript": true, "python": true}, "memoryEnforced": true}` (extra fields are allowed).
- `POST /warm {"size": n}` → `{"ok": true, ...stats}`.
- `POST /load {"sandboxId", "memoryMiB"?}` → `{"ok": true, "hit", "ms", "memoryMiB"}`. memoryMiB (128–512, default 256)
  is now ENFORCED per isolate: one limit on the sum of the V8 heap, ArrayBuffers and wasm memory (`terminated:
  "memory"`, exit 137, when a command takes it over; a buffer or wasm allocation past it may instead fail with a
  RangeError / MemoryError that the program can handle).
- `POST /exec {"sandboxId", "command", "cwd"?, "env"?, "manifest", "timeoutMs"?}` → `{"exitCode", "stdout", "stderr",
  "manifest", "changed", "timings", "hit", "ms"}` plus two new optional fields:
  - `"terminated": "cpu" | "memory" | "wall"` when the runtime stopped the command (exit code 152 for cpu/wall, 137 for
    memory, as in the spike);
  - `"needsMicrovm": {"command": "<name>", "reason": "<one sentence>"}` when the command failed because the isolate
    doesn't have something it ran (an unavailable command such as `git`, `tar`, `apt-get`, `docker`, `pip install`).
    The shell's message stays: `<name>: not available in an isolate... Use a microVM.`, exit 127.
- Sandbox state is the manifest the host sends (path → {kind:"file", sha, size, mode} | {kind:"symlink", target} |
  {kind:"dir"}), under `/workspace`; the runtime returns the next manifest. Unchanged files keep their entries without
  being read.

## Commands in the isolate's shell (just-bash 3.6.0 as today, plus)
- `node` (`-e`, `-p`, a script, `-` / stdin, `-v`): agent JavaScript (and `.ts` with types stripped) in a fresh
  isolate per run with its own limits; console, process (argv, env, exit, cwd, stdout/stderr), a `node:fs` over the
  sandbox's files (writes go into the manifest), path/util/os/events/buffer/crypto, relative imports (ESM and CJS),
  fetch and timers through the egress. No npm packages, no `eval`/`new Function` unless the runtime can allow them
  safely, no child_process.
- `python` / `python3` (`-c`, a script, `-` / stdin, `-V`): Pyodide (pinned version) restored from a memory
  snapshot, in a fresh isolate per run with its own limits; print capture, `sys.argv`, exit codes, the sandbox's files
  under `/workspace`, network through the egress (pyfetch / `from js import fetch`); the packages that ship with the
  pinned Pyodide may be loaded from `--assets` (numpy at least), never from the internet.

## Upgrade to a microVM (API, owned by the upgrade workstream)
- `POST /v1/sandboxes/{id}/upgrade {"size"?, "resources"?, "image"?, "wait"?}` turns a running or stopped isolate into
  a microVM with the SAME sandbox ID, name, labels, env, environments, egress grants and protected variables; the
  isolate's `/workspace` files appear in the microVM at `/home/user/workspace` and `/workspace` is a symlink to it; the
  isolate is disposed of once the microVM runs. Answers the sandbox (type `microvm`).
- `autoUpgrade: true` on a sandbox (create or PATCH): when a command answers `needsMicrovm`, Kantel upgrades the
  sandbox and runs the command again in the microVM, and the command's record says so.
- The command view in the API gains `needsMicrovm` and `terminated` as above.

## Capabilities
- `capabilities` gains `javascript` and `python` (booleans): true for an isolate on a host whose runtime reports them,
  true for a microVM. `GET /v1/sandbox-shapes` → `isolate.memoryEnforced` becomes true when every eligible host's
  runtime enforces memory.

## Additions during W1 (agreed with the parent; the sections above are amended by these)
These were added after the workstreams started, from W2/W3/W4 findings. They are part of the contract.

### Transports (TCP or Unix sockets)
- `--listen`, `--store` and `--egress` accept `host:port`, an `http://host:port` URL, or `unix:/absolute/path`. In
  native mode kantel-host puts each account's runtime in its own 0700 directory under `/run/kantel-isolate`: the
  runtime listens on `unix:<dir>/runtime.sock`, and the host serves `store.sock` and `egress.sock` (0600) in that
  directory (egress proxy-style HTTP over the socket). When all three are `unix:`, the runtime opens no TCP at all,
  so one account's runtime can't reach another's over loopback (W2 finding 5).
- `kantel-isolate version` prints `"unixSockets": true` and `"transports": ["tcp","unix"]`; `GET /healthz` also
  carries `"transports": ["tcp","unix"]`. kantel-host reads `version` and uses Unix sockets when `unixSockets` is true.
- Native mode runs each runtime under its own non-root uid with no supplementary groups, in a cgroup
  (`memory.max` = the account's memory, `pids.max` 4096). The runtime keeps thread creation well under that:
  roughly one thread per live sandbox (`--max-sandboxes`, default 64) plus the node/python ready pools, the
  bounded in-flight `--max-runs`, the 8 IO workers and one watchdog.

### Randomness after a template restore
- `POST /reseed {"entropy": "<hex>"}`: kantel-host calls it right after restoring a VM from the template snapshot.
  The runtime drops every idle pooled and session isolate so they are rebuilt fresh in the restored VM; a
  process-wide V8 entropy source (seeded from the OS, mixed with the posted entropy and a per-isolate counter) gives
  each new isolate a distinct `Math.random`/`$RANDOM`, so VMs restored from one template diverge.
- Python's `random` is reseeded from fresh OS entropy at the start of every run (its Mersenne state is baked into the
  Pyodide memory snapshot). `os.urandom`/`secrets` already draw on the host RNG.

### Health
- `GET /healthz` carries `"warm": true` once the pools are full and start-up work is done, so kantel-host can take
  the template snapshot after it (it waits for `warm`, or a short time after the pool fills).

### Build and packaging (for W3's image build)
- `Cargo.lock` is committed. The crate builds with Rust 1.91 (edition 2024) on glibc (`rust:1.91-bookworm`).
- `build-assets.sh <out-dir> [--bin <kantel-isolate>] [--cache <dir>]` bundles the guest, fetches and verifies the
  pinned Pyodide files and the numpy wheel against `assets.lock` (SHA-256), and makes the Pyodide memory snapshot by
  running the binary (`kantel-isolate python-snapshot`). It is offline once a download cache is present
  (`--cache`/`KANTEL_ISOLATE_CACHE`, `KANTEL_ISOLATE_OFFLINE=1` to forbid network). The Pyodide memory snapshot is a
  WebAssembly linear-memory dump and is architecture-independent, so a cross-built arm64 image can reuse a snapshot
  made on the amd64 builder (no QEMU needed for the snapshot step).
- The guest bundle is compiled into the binary (`include_str!`), not loaded from `--assets`; `--assets` holds the
  Pyodide distribution and the memory snapshot. The guest must be bundled (`bun run guest/build.ts`) before
  `cargo build`.
