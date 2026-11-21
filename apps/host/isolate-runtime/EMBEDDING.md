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
handle's `exec(request, manifest, workspace, command)` runs one command in it (the workspace is the filesystem
provider's, below) (`load(memory_mib)` changes its memory). The
`node`/`python` ready pools are filled by `isolate::node_refill()` and `isolate::python_refill()` (the sizes are in
`Config`). `server::serve(config, embedding)` is the whole of `kantel-isolate serve`, Kantel's HTTP protocol, for an
embedder that wants it as it is.

## The embedding

`Embedding { guest, extensions, filesystem }` (`filesystem` is [below](#the-filesystem-provider)):

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

## The filesystem provider

`Embedding::with_filesystem(provider)` sets where sandboxes' files come from and where commands' changes go
([`src/workspace.rs`](src/workspace.rs)). Without one, the engine uses Kantel's: a manifest per command over the blob
store bridge. One interface serves two models:

- **A manifest per command** (`ManifestProvider`): the host sends the files with each command and keeps what it
  returns. Only that command changes them, so a commit is `committed`.
- **A persistent workspace**: the provider keeps a sandbox's files between commands, and each command's changes are one
  compare-and-swap commit to a durable record. A write whose outcome isn't known is reported as `unknown`, with the
  record as read back after it, and is never replayed; another owner taking the record over fences the workspace.
  `workspace::memory::RecordProvider` is the reference provider of this kind.

`FilesystemProvider::open(sandbox_id, request)` gives the `Workspace` one command runs against (a per-command provider
makes one; a persistent one gives the sandbox's own). `ShellHandle::exec` takes it, and the shell's ops use it:

| Step | `Workspace` method | Op (shell only) | What it promises |
| --- | --- | --- | --- |
| Start | `view()`, `manifest(view)` | (in the request) | Every path and an opaque generation, and the files the guest starts from as a manifest: the view's own, so the files and the base are one version (Kantel's gives the request's manifest). |
| Read | `read(file, cap, charge)` | `op_kt_blob_read(file)` | Only a file a view or `stage` gave this workspace (`NotFound` otherwise). Over `cap` is `TooLarge`, refused before it is read; the bytes are charged to the isolate as they arrive. |
| Stage | `stage(path, bytes)` | `op_kt_stage(path, bytes)` | A blob id a commit may name. Nothing refers to it until then. |
| Commit | `commit(commit)` | `op_kt_commit(json)` | The command's changes from its `base`, applied whole or not at all: removals, then directories, links and files. |
| Catch up | `sync(base)` | `op_kt_sync(base)` | The changes from a version the guest holds to the current one (after the host changed the workspace itself). |

A commit's reply is one of:

- `committed`: the changes are in `catchUp.generation`;
- `unknown`: the write may or may not have landed. `catchUp` is what the workspace holds now; the guest takes it and
  drops the changes it sent, and nothing replays them;
- `failed`: nothing was written, and the changes stand (a bad path, a blob nobody staged, a write the store refused);
- `fenced`: the workspace takes no more commits (another owner has the record, or the commit named a base the workspace
  never gave).

Every reply but `fenced` carries a catch-up from the commit's base, and `fenced` is for good. Kantel's guest shell
reports the files as the workspace holds them: its manifest with the catch-up applied, so the reply names the
provider's own file ids. A command whose commit wasn't `committed` fails (exit 1, a line on stderr, and
`commit: {status, error}` in its reply); after `failed` the reply still has the workspace's own changes since the
command's base (the host's writes), from the catch-up. It commits only what the workspace keeps
(`op_kt_workspace_capabilities`): in a files-only workspace, directories are implied by paths and aren't committed, and
a file or link a directory replaced is removed. A command commits once at a time (a second `op_kt_commit` while one is
running is refused).

A file the command didn't change isn't in its commit, whatever the provider's ids are. Where they are the bytes'
SHA-256 (`Capabilities::content_addressed`, as Kantel's are) the guest compares ids; otherwise it compares the bytes'
digest with what the command read (or, for a file written over unread, reads the original to compare).

The commit runs as a task on the engine's I/O runtime, so a command stopped while it waits for its commit (CPU, wall
clock, memory) doesn't cut the write off. The stopped command's reply waits for the commit (`Config::commit_grace`,
15 s) and reports the files as the workspace then holds them (`sync` from the command's base), with
`commit: {status: "unknown"}` when the outcome isn't known. A commit still running after that holds the sandbox's next
command back (refused with `retryable: true`, a 503 from `kantel-isolate serve`) until it ends, so it can't land over
later work.

A persistent provider over a durable record fits as follows. File ids are strings, so a provider that numbers its
files per session formats the number. Read-only and scratch areas (files the session may read but not change, or a
`tmp` that is never saved) are the guest filesystem's to enforce; the provider refuses a commit that touches them
(`failed`). A provider that keeps files only reports `directories: false, symlinks: false` in its `Capabilities` and
refuses directories and links in a commit. A file node may carry `mtimeMs` and a content `hash` for the guest's
listings and the host's caches. A host command that writes files (one the host runs natively on the session's files)
commits through the same workspace, and the guest catches up with `sync`. Warming the host's caches before reads is the embedder's own op.

### The contract tests

`workspace::contract` is the contract as tests: `common` for every provider, `persistent` for the faults a persistent
one meets (a refused write, a lost reply that landed or didn't, a base behind the record, another owner taking over).
`tests/workspace_contract.rs` runs them against both of the crate's providers, and `tests/guest_workspace.rs` runs
Kantel's guest shell over the persistent one. An embedder runs them against its own provider by implementing
`contract::Subject` (and `contract::Persistent`), as `contract::subjects` does:

```rust
#[tokio::test]
async fn our_provider_keeps_the_contract() {
    let subject = OurSubject::new(); // implements Subject and Persistent
    kantel_isolate::workspace::contract::common(&subject).await;
    kantel_isolate::workspace::contract::persistent(&subject).await;
}
```

## The limits

The limits are in the table in [README.md](README.md#limits-and-what-enforces-each). The runtime enforces CPU, wall
clock, the V8 heap and ArrayBuffers for every isolate, whatever the guest (`tests/embedding.rs` checks a command past
its wall clock is stopped and the isolate kept). WebAssembly memory and resizable buffers count against the same limit
only when the bundle installs the guards above.

## What may change

- Everything public in the crate may change between revisions; this file says what an embedder can rely on. A change
  to it is made in the same commit as the code.
- Kantel's own guest bundle, ops (`kt`) and HTTP protocol follow CONTRACT.md, not this file.
