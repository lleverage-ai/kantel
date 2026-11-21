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

`consumer/` is the smallest embedder there is (its own guest bundle and op, a filesystem provider it runs the
contract tests against, and a host command), and CI builds and runs it against each commit as a git dependency on
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

`Embedding { guest, extensions, filesystem, host_commands }` (`filesystem` and `host_commands` are below):

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

The simplest way to a working bundle is Kantel's own guest pieces, the `@kantel/isolate-guest` package in `guest/`
([guest/README.md](guest/README.md)): `createGuest({ shell: { filesystem } })` is a whole bundle's `__kantel`, with
the guards installed, node and python, and the shell over the embedder's own filesystem
(`createGuest({ shell: { filesystem, commands } })` adds the embedder's own commands, written in JavaScript, to the
shell: see the package's README). Kantel's bundle,
`guest/main.js`, is `createGuest()` with its manifest filesystem.

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
| Read | `read(file, cap, charge)` | `op_kt_blob_read(file)` | Only a file a view or `stage` gave this workspace (`NotFound` otherwise). Over `cap` is `TooLarge`, refused before it is read; the bytes are charged to the isolate as they arrive. Only ever the guest's read. |
| Read for the host | `host_read(file, cap)`, `read_range(file, start, len)` | (a host command's `files`) | The same files, read for a host command: charged to no isolate and not held to a cap the provider keeps for the isolate, only to the host's `cap`. A range is exactly `len` bytes from `start`, fewer only at the file's end, none at or past it. Both have defaults (`read(file, cap, None)`, and that whole read sliced), so a provider that overrides neither reads for the host as for the guest. |
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

A file id always names the same bytes: a changed file gets a new id, and a read of the old one gives the old bytes
or `NotFound`, never the new ones (so every range of one id is of one version of the file).

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

`workspace::contract` is the contract as tests: `common` for every provider (reads for the guest and for the host,
ranges included), `persistent` for the faults a persistent one meets (a refused write, a lost reply that landed or
didn't, a base behind the record, another owner taking over).

A lost reply is `unknown`, with the record as read back, unless the provider can tell what its write did. One that
reads the record back and finds its write there (or finds it didn't land, and sends it once more) may answer
`committed` with the changes in: it says so with `Persistent::lost_reply_resolution` returning `Resolution::ReadBack`,
and implements `Persistent::lose_next_reply_and_move_on`, a lost reply after which another writer (not a new owner)
moves the record on before it is read back. There the provider can't tell, and the contract requires `unknown`. Either
way the record is as it is, never half, and nothing replays a change the guest dropped. Both methods have defaults
(`Resolution::Unknown`, and no moved-on check), so a provider that answers `unknown` needs neither.
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

## Host commands

`Embedding::with_host_command(name, command)` registers a program the embedder runs natively on the host for the
guest's shell ([`src/host_commands.rs`](src/host_commands.rs)): an SQL engine over a large file, a search tool, an
archive or document reader, whose bytes then never enter the isolate. The guest shell defines a command of that name
(`op_kt_host_commands`); a name the isolate otherwise lacks (`unzip`, `duckdb`) is served, never refused before
running nor reported as `needsMicrovm`.

`HostCommand::run(request)` runs on the engine's I/O runtime, ended at the shell command's deadline (exit 124) and
cancelled if the shell cancels it (`timeout`) or the command is stopped. The `HostRequest` has the arguments, working
directory, environment and stdin, and `files`: the shell's files as they are at that moment (`read(path, cap)` reads
one, a path absolute or relative to the working directory and inside `/workspace`, through the workspace or inline
if the command changed it; symbolic links in a path are followed as the shell follows them, and one leading out of
`/workspace` is refused). A host command reads for the host (`Workspace::host_read`), so the isolate's read cap
doesn't hold it back; its own `cap` does. A file too large to take whole is read in ranges (`read_range(path, start,
len)`), each of the file as it was when the command started; `file(path)` gives its size and, when its bytes are the
workspace's (untouched, or a staged output), the workspace's id for it (`HostFile { id, size }`, `id: None` for a
file the command wrote in the shell), for an embedder whose own child process reads the file from its storage. The
guest's index names the file, so `file` checks the id with the workspace (`host_read(id, 0)`) and gives the
workspace's size: an id the workspace never gave this command is an error, never handed out. The `HostReply` has the exit code, stdout and stderr, and the files it writes and
removes. A host command never commits: its changes become the shell command's own and are saved by its one commit,
so a stopped or cancelled command, an unknown outcome and the next command are handled once for everything.

- Small outputs come back inline (`HostWrite::Bytes`; at most 64 MiB inline per reply, stdout and stderr included).
- A large output is staged first (`files.stage(path, bytes)`) and answered as `HostWrite::Staged`: the shell keeps
  it as a file it reads only if the command does (`adoptStaged` in the shell filesystem), and its commit names the
  staged blob, so the bytes never pass through the isolate. `files.stage` gives the bytes' SHA-256 as the staged
  `hash`, so an output that is what the file already was (bytes and mode) is no change, as an inline one isn't. The
  shell knows a staged output by its body, not its path: anything that replaces the body makes it an ordinary file.

An error from `run` is the command's failure (exit 1, the error on stderr). `tests/host_commands.rs` runs these
through Kantel's guest shell.

## Memory for an embedder's own isolates

An isolate the embedder makes itself (a program isolate, say) can be held to the same one budget as the runtime's
([`src/memory.rs`](src/memory.rs)):

```rust
let budget = kantel_isolate::memory::Budget::new(256 << 20);
let mut rt = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
    create_params: Some(kantel_isolate::memory::create_params(&budget)),
    ..Default::default()
});
let mut watch = kantel_isolate::memory::watch(&mut rt, &budget);
// While guest code runs, on the isolate's thread: over the budget, its CPU or its wall clock, it is stopped.
let running = kantel_isolate::memory::enforce(&mut rt, &budget, cpu, wall)?; // one run at a time
// ...
drop(running);
watch.remove(&mut rt); // before the isolate is dropped
```

`memory::array_buffer_allocator(&budget)` is the ArrayBuffer allocator for this build's V8: a Rust allocator that
charges the budget on the stock V8, and Kantel's in-sandbox budget allocator on the sandboxed one. Use it instead of
`v8::new_rust_allocator`, which the sandboxed V8 doesn't have. WebAssembly memory counts only when the guest reserves it
(Kantel's wasm guard does). `memory::enforce` registers the isolate with the runtime's watchdog, which also stops it
when a GC found the total over the limit and the program then stopped allocating. `tests/memory.rs` runs on the V8 the
crate is tested with (CI's: the sandboxed one).

## Egress and hardening

What guest code may send out is `Config::egress_policy` ([`EgressPolicy`](src/config.rs)): whether it may at all, the
header that carries the sandbox id to the egress proxy (a guest's own header of that name is dropped), the methods
allowed (never CONNECT), the largest response body, and the requests one isolate may have in flight. The default is
Kantel's. Every request goes to `Config::egress`, in proxy style.

What the process does to itself is a [`HardeningPolicy`](src/harden.rs), applied by `harden::harden(config, policy)`
before the first thread starts: no root or capabilities and not dumpable, then Landlock (the assets read-only, a
private temporary directory, the policy's `read`, `read_write` and `execute` paths, and the transport's socket
directory or ports), then seccomp (`seccomp: None` for no filter). `HardeningPolicy::kantel` is the binary's. With
`spawn`, the process may start child processes (fork and clone without namespaces, exec, wait, signal) for an
embedder's own worker or helper: a child inherits Landlock and the filter, so it can execute only what `execute`
names and must keep to the same allow-list. Writable places (the temporary directory, `read_write`, the socket
directory) are never executable, and `harden` refuses an `execute` path that overlaps one (inside it or containing
it, symlinks resolved). A redirect is checked against
the egress methods too.

## The limits

The limits are in the table in [README.md](README.md#limits-and-what-enforces-each). The runtime enforces CPU, wall
clock, the V8 heap and ArrayBuffers for every isolate, whatever the guest (`tests/embedding.rs` checks a command past
its wall clock is stopped and the isolate kept). WebAssembly memory and resizable buffers count against the same limit
only when the bundle installs the guards above.

## What may change

- Everything public in the crate may change between revisions; this file says what an embedder can rely on. A change
  to it is made in the same commit as the code.
- Kantel's own guest bundle, ops (`kt`) and HTTP protocol follow CONTRACT.md, not this file.
