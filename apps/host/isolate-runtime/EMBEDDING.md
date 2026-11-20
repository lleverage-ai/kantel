# Embedding kantel-isolate

kantel-isolate is a library (`kantel_isolate`, `src/lib.rs`) with a thin binary around it (`kantel-isolate`,
`src/main.rs`: the command line, Kantel's guest bundle and the process allocator). Another program can embed the same
runtime: one V8 isolate per shell sandbox, a fresh one per `node` or `python` run, one memory budget for the heap,
ArrayBuffers and wasm, CPU and wall-clock limits, and op gating by isolate kind. This file is the contract between the
runtime and an embedder. [CONTRACT.md](CONTRACT.md) is the other one, between the binary and kantel-host.

## Depending on it

The crate isn't on crates.io. Depend on it by git revision, and turn default features off (the only default feature
is the binary's jemalloc allocator; pick your own process allocator):

```toml
[dependencies]
kantel-isolate = { git = "https://github.com/lleverage-ai/kantel", rev = "<commit>", default-features = false }
```

It builds with Rust 1.91 or later (edition 2024) on Linux with glibc, against deno_core 0.412 and V8 150.4 (the `v8`
crate). Pin the revision: nothing below is semver-stable yet, and a breaking change is announced in this file's
history rather than by a version number.

### Stock or sandboxed V8

- **Stock V8** (the default): rusty_v8's prebuilt static library, downloaded by the `v8` crate's build script (or the
  one `RUSTY_V8_ARCHIVE` names).
- **V8 with its heap sandbox** (`features = ["v8-sandbox"]`): Kantel's build of V8 (`v8/build-v8-sandbox.sh`, published
  as release assets and fetched and checked by `v8/fetch-v8-sandbox.sh`, which prints `RUSTY_V8_ARCHIVE` and
  `RUSTY_V8_SRC_BINDING_PATH`), plus deno_core and serde_v8 with Kantel's patches, which only link against that V8. A
  crate can't carry a `[patch.crates-io]` for its dependents, so the embedder adds it:

  ```sh
  apps/host/isolate-runtime/v8/vendor-patched.sh vendor   # deno_core and serde_v8, checked and patched
  ```

  ```toml
  [patch.crates-io]
  deno_core = { path = "vendor/deno_core-0.412.0" }
  serde_v8 = { path = "vendor/serde_v8-0.321.0" }
  ```

`consumer/` is the smallest embedder there is, and CI builds and runs it against each commit as a git dependency on
both V8s (`consumer/check.sh`, run in the build container by `apps/host/guest/isolate-runtime.sh consumer`): copy its
setup.

## Starting the runtime

Once per process, in this order:

1. Harden the process if you mean to (`kantel_isolate::harden`, or your own): V8's platform and the runtime's
   threads inherit Landlock and seccomp only if they start after them.
2. `kantel_isolate::init_v8()`: V8's flags, its entropy source and its platform.
3. `Engine::init(config, embedding, io, debug)`: the runtime's settings ([`Config`](src/config.rs)), the
   [`Embedding`](src/embed.rs), the tokio runtime its bridges and ops do I/O on, and whether guest logs are shown.
   It builds the startup snapshot from the embedding's guest bundle and ops; every isolate is made from it.

Then `isolate::spawn_shell(sandbox_id, memory_mib, warm)` makes a sandbox's shell isolate on its own thread, and the
handle's `exec(request, manifest, command)` runs one command in it (`load(memory_mib)` changes its memory). The
`node`/`python` ready pools are filled by `isolate::node_refill()` and `isolate::python_refill()` (the sizes are in
`Config`). `server::serve(config, embedding)` is the whole of `kantel-isolate serve`, Kantel's HTTP protocol, for an
embedder that wants it as it is.

## The embedding

`Embedding { guest, extensions }`:

- **`guest`**: the guest bundle, one classic script, evaluated once into the startup snapshot. It is the embedder's
  JavaScript: Kantel's is `guest/main.js` bundled to `guest/dist/guest.js`.
- **`extensions`**: a function that returns the embedder's own deno_core extensions. The runtime calls it for the
  snapshot and for every isolate, and adds what it returns after its own `kt` extension. It must return the same ops in
  the same order every time (deno_core requires an isolate's ops to match its snapshot's).

### The guest bundle

The bundle must leave `globalThis.__kantel = { init(kind) }` behind. For each new isolate the runtime calls
`__kantel.init(kind)` once, with `kind` one of `"shell"`, `"node"` or `"python"`, and keeps what it returns as that
isolate's entry point. Before it returns, `init` must remove every route from guest code to the ops: `Deno`,
`__bootstrap` (the route Pyodide's `js` module reaches) and `__kantel` itself. After that, nothing the guest runs can
call an op except through the functions `init` closed over.

The runtime calls these entry points, each with JSON-encoded arguments:

| Kind     | Entry point                         | Answer                                                                          |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `shell`  | `exec(request)`                     | The command's result as a JSON string (Kantel's: `exitCode`, `stdout`, `stderr`, `manifest`, `changed`, `timings`, optionally `needsMicrovm`, `terminated`). `request` is what the embedder passed to `ShellHandle::exec`. |
| `node`   | `start(meta)`, then `finish(error)` | `start` answers `{}` or `{ "esm": "<file URL>" }` (a module the runtime loads and evaluates); the run's result is what the guest hands `op_kt_set_result`. |
| `python` | `boot(args)`, then `run(meta)`      | `boot` loads Pyodide from the assets directory once per isolate (`args.pyodide`); `run`'s result goes through `op_kt_set_result`. |

`eval` and `new Function` throw in a shell isolate (it is long-lived and never needs them); they work in the single-use
node and python isolates. A shell isolate is reused for its sandbox's next command, so the guest builds its state per
call (Kantel's builds a fresh just-bash and filesystem for each `exec`).

The simplest way to a working bundle is Kantel's own guest pieces, composed with your shell: see `guest/main.js`.

#### The guards a bundle must install

Part of the memory limit is enforced in JavaScript, by the guest bundle, not by the runtime: WebAssembly memory and
resizable or growable ArrayBuffers are allocated outside both the V8 heap and the ArrayBuffer allocator the runtime
counts. Kantel's `init` installs, before any guest code runs and in this order:

1. `fixBuffers(globalThis)` (`guest/common/buffer-guard.js`): refuses resizable and growable buffers;
2. `captureShared(globalThis)` (`guest/common/primordials.js`), then deletes `SharedArrayBuffer` and `Atomics`;
3. `installWasmGuard(ops, mode)` (`guest/common/wasm-guard.js`): reserves every wasm memory against the isolate's
   budget through `op_kt_wasm_reserve` (`"strict"` for shell and node, `"boot"` then its lockdown for python).

A bundle that lets untrusted code run without these has no limit on wasm memory beyond V8's process-wide one (512 MiB
per memory), whatever the isolate's memory limit. Install them as Kantel's `guest/main.js` does.

### The embedder's ops

An embedder's op runs on the isolate's thread, with that isolate's `OpState`. It must:

- **Check who is asking.** `Ctx::of(state)` is the running command's context (`kind`, `sandbox_id`, `command` with its
  CPU budget and deadline, `budget` for memory), or `None` outside a command (the runtime unbinds it when a shell
  command ends). An op meant for one kind of isolate refuses the others, as the runtime's own do
  (`"not available here"`).
- **Never panic on guest input.** A panic in an op takes the whole process down, every sandbox with it. No
  `unwrap`/`expect` on anything the guest controls.
- **Charge what it hands the guest.** Bytes returned to the guest are charged to the isolate's memory budget before
  guest code can see them: return `hostbuf::HostBytes::charge(isolate, &state, bytes)` (or `adopt`, for bytes already
  charged while they were collected) rather than a `Vec<u8>`, so a host-returned buffer can't sit outside the limit.
- **Not block the isolate's thread** on I/O: do it on the engine's I/O runtime (`engine().io`) from an async op.

## The limits

The limits are in the table in [README.md](README.md#limits-and-what-enforces-each). The runtime enforces CPU, wall
clock, the V8 heap and ArrayBuffers for every isolate, whatever the guest (`tests/embedding.rs` checks a command past
its wall clock is stopped and the isolate kept). WebAssembly memory and resizable buffers count against the same limit
only when the bundle installs the guards above.

## What may change

- Everything public in the crate may change between revisions; this file says what an embedder can rely on. A change
  to it is made in the same commit as the code.
- Kantel's own guest bundle, ops (`kt`) and HTTP protocol follow CONTRACT.md, not this file.
