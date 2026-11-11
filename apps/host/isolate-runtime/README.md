# kantel-isolate

Kantel's isolate runtime. One process per account's isolate VM (or one per account on a native host) that runs an
account's isolate sandboxes: a shell ([just-bash](https://github.com/vercel-labs/just-bash)), `node` and `python`,
each in its own V8 isolate on [deno_core](https://crates.io/crates/deno_core), over files kept as a manifest the host
sends. It replaces the workerd worker in `apps/host/isolate` and `images/isolate-host`.

It speaks kantel-host's existing isolate protocol (`GET /healthz`, `POST /warm`, `/load`, `/exec`), so
`apps/host/internal/isolate/isolate.go` drives it unchanged, plus the new fields and routes in
[CONTRACT.md](CONTRACT.md) (`terminated`, `needsMicrovm`, `POST /reseed`, Unix-socket transports).

## What it is

- **Shell:** just-bash 3.6.0 over an in-memory filesystem built from the manifest. File bodies are read from the
  host's blob store (`--store`) only when a command reads them; changed files are uploaded at the end of each command
  and returned as the next manifest. `/workspace` is the root, `HOME=/workspace`. Commands that need a real machine
  (`git`, `tar`, `apt`, `docker`, `pip install`, …) answer exit 127 with `needsMicrovm` so Kantel can offer or make
  the microVM upgrade.
- **node:** agent JavaScript (and `.ts` with types stripped) in a fresh isolate per run — `node -e`/`-p`/a
  script/`-`/`-v`, `console`, `process`, a `node:fs` over the sandbox's files, `path`/`util`/`os`/`events`/`buffer`/
  `crypto`/`stream`/`readline`/`url`/`assert`/`timers`/`zlib`, relative CommonJS and ESM imports, `fetch` and timers
  through the egress. No npm packages, no `child_process`, no servers.
- **python:** Pyodide 3.14 (pinned) restored from a memory snapshot, in a fresh isolate per run — `python -c`/a
  script/`-`/`-m`/`-V`, print capture, `sys.argv`/`sys.stdin`, exit codes, the sandbox's files under `/workspace`,
  network through the egress (`pyfetch`, `from js import fetch`), and the packages that ship with Pyodide (numpy at
  least) loaded from `--assets`, never the internet.

Every request out of a sandbox goes through the host's egress proxy (`--egress`), tagged with the sandbox id; the
guest never reaches the store or the proxy itself.

## Build

The guest bundle is compiled into the binary, so bundle it first, then build the crate:

```sh
bun install                        # in apps/host/isolate-runtime
bun run guest/build.ts             # writes guest/dist/guest.js
cargo build --release              # needs a V8 build (see below)
```

V8 is built by the `v8` crate. To reuse a prebuilt archive (much faster), set `RUSTY_V8_ARCHIVE` to a
`librusty_v8_*.a`. The default features are `jemalloc` (process allocator) and the stock V8. The `v8-sandbox` feature
builds V8 with its heap sandbox and pointer compression on (W2 ships the matching allocator patch); `kantel-isolate
version` reports which one a binary has as `"v8Sandbox"`.

### Assets

`build-assets.sh <out-dir> [--bin <kantel-isolate>] [--cache <dir>]` makes the `--assets` directory: it bundles the
guest, fetches the pinned Pyodide distribution and the numpy wheel and checks them against `assets.lock` (SHA-256),
then makes the Pyodide memory snapshot by running `kantel-isolate python-snapshot`. It is offline once a download
cache is present (`--cache`, or `KANTEL_ISOLATE_CACHE`; `KANTEL_ISOLATE_OFFLINE=1` forbids the network). The memory
snapshot is a WebAssembly linear-memory dump and is architecture-independent, so a cross-built arm64 image can reuse a
snapshot made on an amd64 builder.

## Run

```sh
kantel-isolate serve \
  --listen 127.0.0.1:8080 \
  --store http://127.0.0.1:7001 \
  --egress http://127.0.0.1:7002 \
  --assets /opt/kantel-isolate
```

`--listen`, `--store` and `--egress` also take `unix:/absolute/path` (native mode puts each account's runtime and its
bridges on 0600/0700 Unix sockets). Other flags (all have defaults, and each reads `KANTEL_ISOLATE_<FLAG>`):
`--pool`, `--node-pool`, `--python-pool` (pre-loaded isolates), `--cpu-ms` (per command, default 120000),
`--max-sandboxes`, `--max-runs` (concurrent node/python runs), `--idle-ms`, `--log-format json|text`.
`kantel-isolate version` prints `{version, v8, v8Sandbox, unixSockets, transports}`.

## Test

```sh
cargo test --release                       # Rust unit tests (limits, config, bridges, wasm, transpile)
# integration suite (bun): starts the binary against STORE/egress stand-ins
KANTEL_ISOLATE_BIN=target/release/kantel-isolate \
KANTEL_ISOLATE_ASSETS=<assets-dir> \
  bun test test/integration.test.ts
```

The integration suite covers protocol parity with the behaviours `sandbox.ts` had, manifest semantics, node and
python features, egress tagging, `needsMicrovm`, `terminated`, the containment attacks (B5) with a neighbour
sandbox's latency checked, the one memory limit (heap then buffers and the reverse, in the shell, node and python),
and native mode's transport: a subset runs with the runtime, the store and the egress proxy on Unix sockets in a 0700
directory, and checks the process has no TCP or UDP socket (in its own network namespace where unprivileged user
namespaces are available) while a guest fetch still reaches the egress socket. It uses ports 29310–29343
(`KANTEL_ISOLATE_TEST_PORT` moves them). It skips with a message if the binary or assets aren't built, so `pnpm test`
at the repo root (which doesn't build Rust) doesn't fail. W3 owns adding the Rust build and this suite to CI.

## Limits, and what enforces each

Per isolate, together where noted:

| Limit | Enforced by |
| --- | --- |
| Memory (`memoryMiB`, 128–512, default 256) | One limit on the sum of the V8 heap, ArrayBuffers and WebAssembly memory. A GC epilogue records the heap in use after every GC; buffers (the ArrayBuffer allocator's byte budget) and wasm memory (the guest's wasm guard) are refused past memoryMiB minus that heap, and the epilogue terminates the command (exit 137, `terminated: memory`) when heap + buffers + wasm is over memoryMiB, so heap growth on top of buffers is stopped too. The V8 heap limit stays memoryMiB, with a near-heap-limit callback that terminates, as the backstop between GCs. |
| CPU per command | A watchdog thread samples each isolate thread's CPU clock and terminates past `--cpu-ms` (exit 152, `terminated: cpu`); a `node`/`python` run's CPU counts against the shell command that started it. |
| Wall clock per command | The same watchdog terminates past the request's `timeoutMs` (max 10 min), default 30 s (exit 152, `terminated: wall`). |
| Concurrent node/python runs | `--max-runs` (default 2× CPUs, 2–16); over it a run answers a clear "runtime is busy" error. |
| Concurrent egress requests per isolate | 8; over it `fetch` throws. A response body is charged against the isolate's memory as it arrives (and a process-wide in-flight cap), and the I/O is aborted when the run ends. |
| Live sandboxes | `--max-sandboxes`; the least-recently-used idle one gives up its isolate past the cap, and an idle sandbox gives it up after `--idle-ms`. |
| Output per command | 128 MiB (shell), 16 MiB (node/python). |

A terminated command's shell isolate is reset in place (its terminate flag cleared and a low-memory notification
issued) and reused for the sandbox's next command; a `node`/`python` isolate is single-use and discarded. The
sandbox's state is the manifest the host holds, so nothing persisted is lost on a reset.

## Security model

The runtime runs **inside one account's isolate VM** (or one process per account on a native host): everything it runs
is that one account's code, and the VM (and, natively, a per-account uid + cgroup + W2's seccomp/landlock) is the
boundary between accounts. Within the process, each sandbox is its own V8 isolate, and the runtime trusts:

- **V8 isolation** between a sandbox's code and the host. Guest code reaches the host only through the `kt` ops, and
  those are made unreachable before any guest code runs: the guest bundle's entry point removes `Deno`, `__bootstrap`
  (the `Deno.core.ops` route Python could reach via `js.__bootstrap`) and `__kantel` from the global, and each op also
  refuses to act for the wrong isolate kind. `eval`/`new Function` are disabled in the shell isolate (it never needs
  them); they stay on in the single-use node/python isolates, whose CommonJS loader builds a function from the run's
  own source.
- **The egress proxy** (`--egress`) to decide what may leave. The runtime tags each request with the sandbox id and
  drops the guest's own `kantel-*` and hop-by-hop/framing headers, and allow-lists methods (no `CONNECT`).
- **The blob store** (`--store`) for the account's files. The shell may read only the digests its current manifest
  names or ones it has written, not any blob of the account by SHA.
- **Per-isolate limits** (above) to stop one sandbox starving its neighbours; the process never aborts on a sandbox's
  CPU, memory or wasm bomb (verified by the B5 tests). `SharedArrayBuffer`, `Atomics` and a sub-millisecond
  `performance.now()` are removed, to blunt timing side channels within the process.
- **A path-restricted module loader:** node loads only the run's own files (from the manifest/overlay); python loads
  only Pyodide's modules and packages from `--assets`. Importing a `.wasm` module in node is refused (it would bypass
  the wasm budget).

This is weaker than a microVM against a V8 escape: an escape lands in the account's own runtime process, not a
per-sandbox sandbox. That is why the runtime runs in the account's isolate VM, and natively under W2's process
hardening (seccomp, landlock, a dedicated uid and cgroup), which this crate deliberately leaves to W2.

## Known gaps

- **The memory limit is checked at GCs and allocations, not continuously.** The heap figure is the last GC's, so
  between GCs the heap can grow past memoryMiB minus the buffers until the next GC (V8 collects often while the heap
  grows) or, at worst, the heap limit (memoryMiB) — the backstop. Buffers count until V8 frees them, so the epilogue
  stops a command only when the total is over at a full GC and still over at the GC after it (by then the buffers
  that GC found dead are freed); a stock-build allocation refused only because of the heap figure first lets V8
  collect and retry. In a `v8-sandbox` build the C++ budget allocator holds ArrayBuffers to memoryMiB on their own
  (its limit can't be changed without rebuilding the patched V8), and buffers taken on top of the heap are stopped
  at the next GC, which V8 runs as external memory grows, rather than in the allocation itself; a program that takes
  them and then idles without allocating can hold them until then. Host-returned buffers (file reads, fetch
  bodies, `core.encode`) are copied into the budget in stock builds and allocated through the in-sandbox budget
  allocator in `v8-sandbox` builds, so they can't be retained outside it. A just-bash command holds a file it reads
  about twice over (the read and its own copy), so a shell reading a file of more than about 45% of memoryMiB is now
  stopped where it used to fit.
- **The memory guards are JS-level.** The wasm guard (every `WebAssembly.Memory`/`grow`/`Module`/`Instance`, plus a
  host module inspection) and the resizable-buffer guard are installed before any guest code, use primordials
  captured at snapshot time (a guest can't defeat them by swapping `Reflect.construct`, `WeakMap.prototype.get`, …),
  and are made non-configurable. Python's guard is locked down after Pyodide boots. They are watertight for the
  attacks tested, but a true V8 escape would bypass them like anything else — the isolate VM (and W2's seccomp /
  Landlock / heap sandbox) is the boundary that doesn't depend on V8.
- **node is not Node.** No npm install, no `child_process`, no servers/sockets, no native addons, no worker threads.
  Named imports from a CommonJS module imported by ESM aren't resolved (default import only). This is for agent glue
  code, not for building or running projects — that is what a microVM is for.
- **python hash randomisation** is fixed by the snapshot (only `random` is reseeded per run); code that depends on
  per-process hash seeds sees the snapshot's seed.
- **The V8 heap sandbox is off by default** (`v8-sandbox` feature). With it on, the crate uses W2's in-sandbox budget
  allocator and deno_core/serde_v8 are vendored with W2's patches (`v8/sandbox-crate.sh`); the allocator choice is
  behind one function so the stock build needs no patching. Production ships the sandboxed build.
