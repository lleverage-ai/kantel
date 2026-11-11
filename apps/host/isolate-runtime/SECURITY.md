# kantel-isolate: security review and hardening

Lleverage runs Kantel on shared hosts for all its customers. A bug in V8 or in the runtime must not let one customer
reach another, and it should be contained as tightly as practical even within an account. This file covers three
things: the review of the deno_core spike (`/tmp/kt-rt-deno`, which W1's crate replaces), what this directory adds,
and what each workstream must change.

Two layers sit between an account's guest code and other accounts:

1. **The account's own isolate VM** (or, in native mode, the account's own process).
2. **Inside that**, V8's heap sandbox (`v8/`), the process's own Landlock and privilege checks (`hardening/`), and
   the systemd unit (`systemd/kantel-isolate.service`).

## Findings in the spike

Each finding was checked against the running spike, except where noted. The probes are in `/tmp/kt-w2-spike/probes`.
"W1" says whether W1's crate has the fix. All findings were forwarded to W1 on 11 Nov; none has been verified in its
code yet.

### 1. Critical: guest code can call every host op
**Location:** `guest/node.js` `__node.start` (`delete g.Deno`), `py_boot` in `server/src/main.rs`
(`delete globalThis.Deno`).

deno_core also puts its core object on `globalThis.__bootstrap`. That object is frozen but still reachable, so a
node script (`globalThis.__bootstrap.core.ops`) or a Python one (`import js; js.__bootstrap`) can call every op. This
includes all of deno_core's built-in ops (`op_panic`, `op_eval_context`, `op_set_promise_hooks`, …) and all of the
runtime's, in every kind of isolate.

**Fix:**
- Delete `globalThis.__bootstrap` as well, before any guest code runs.
- Better, register per kind only the ops that kind needs: a sandbox isolate never needs Pyodide's ops, and a node
  isolate never needs `op_kt_run` or `op_shared_snapshot`.
- Use deno_core's `ops_builtin` exclusions or a middleware to drop the debug and panic ops.
- Test: `node -e 'console.log(typeof globalThis.__bootstrap)'` prints `undefined`.

**W1:** forwarded.

### 2. Critical: one sandbox can rewrite the Pyodide snapshot every other sandbox's python boots from
**Location:** `op_shared_snapshot` in `main.rs`.

The op returns a writable ArrayBuffer over one process-wide copy of the snapshot, made with
`new_backing_store_from_ptr` over Rust's heap.
- **Shown:** a node run in sandbox A wrote bytes that sandbox B read back. After A overwrote the first 4 MB, other
  sandboxes' `python3` failed with "Snapshot has invalid magic number" once the ready pool was used up.
- **Not tried:** a careful write could change other sandboxes' Python heap state instead of breaking it.

**Fix:** copy the snapshot into each isolate's own allocation. `serde_v8::sandbox::new_array_buffer` does this, and
the sandboxed spike does it (B: `tail 0 0 0 0` after A's write). Also never expose the op to guests (finding 1).

**W1:** forwarded.

### 3. Critical: any guest can abort the whole process
**Location:** deno_core's `op_panic` (reachable through finding 1). More generally, any op that panics.

A panic inside an op called from V8 cannot unwind across the boundary, so it aborts the process. That takes down every
sandbox of the account ("thread caused non-unwinding panic. aborting.").

**Fix:**
- Finding 1's fix.
- Ops must not panic on guest-controlled input: no `unwrap` on parsing, I/O or locks, and use `catch_unwind` around
  op bodies that call into libraries.
- The spike's `op_shared_snapshot` `unwrap`s a file read, and `op_kt_file` builds `off..off + len` from guest
  numbers.

**W1:** forwarded.

### 4. High: blobs can be read by digest across sandboxes
**Location:** `op_kt_blob_read`, `op_kt_file` (`FileRef::Blob`).

Any blob of the account's store can be read by its SHA-256, not just the blobs in this sandbox's manifest. Shown:
sandbox D read sandbox C's file by its digest. The store is per account, so this stays within the account, but it
breaks "one sandbox's files are its own". A digest also leaks easily (for example through `ls -l` sizes plus a
guessable file).

**Fix:** the run keeps the set of digests in the manifest it was given (and those it wrote) and refuses others.
`op_kt_blob_put` needs a per-command byte cap.

**W1:** forwarded.

### 5. High (native mode): another account's runtime and bridges are reachable on 127.0.0.1
**Location:** `apps/host/internal/isolate/isolate.go` `startNative` (from reading the code; not exercised).

How native mode is set up today:
- The store and egress bridges listen on `127.0.0.1:0`.
- The runtime's port is found by listening on `127.0.0.1:0`, closing, and handing the number to the runtime. That
  leaves a race in which another process can take the port.
- The process starts with `os.StartProcess` and no `SysProcAttr`, so it runs as kantel-host's user (root in practice)
  with all its capabilities.
- `serveStore` treats every connection to that listener as the runtime's account, and the runtime's HTTP API trusts
  every connection.

So in native mode, a compromised account process can connect to another account's store port and read or write its
blobs. It can also connect to the other account's runtime and run commands as any of its sandboxes. The microVM mode
doesn't have this problem, because each VM's bridges are vsock ports for that VM only.

**Fix (kantel-host, W3):**
- **Unix sockets** in the runtime's own directory instead of TCP. `r.dir` already comes from `os.MkdirTemp`, which
  makes it 0700. Use `store.sock`, `egress.sock` and `runtime.sock` there, owned by the account's uid. kantel-isolate
  takes `--listen unix:<path>`, `--store unix:<path>` and `--egress unix:<path>`, which is a small contract change. A
  process of another uid can't reach the directory.
- **Its own uid per account:**
  - Allocate uids from a range.
  - Set `SysProcAttr{Credential: &syscall.Credential{Uid, Gid}, Setpgid: true, Pdeathsig: SIGKILL}` with no ambient
    capabilities.
  - Do this before anything else, because the runtime refuses to run as root (`hardening::check_privileges`).
- **Its own cgroup** with `memory.max` and `pids.max`: create `…/kantel-isolate-<account>/` in kantel-host's
  delegated cgroup and start the process in it with `SysProcAttr{UseCgroupFD: true, CgroupFD: fd}` (Linux 5.7).
  - `memory.max` is the account's isolate budget plus about 256 MiB for the runtime itself.
  - `memory.swap.max=0`.
  - `pids.max` covers the runtime's threads (sandbox count + `--max-runs` + about 64).
- **No network** if possible: `Cloneflags: CLONE_NEWNET` gives the process an empty network namespace. With Unix
  sockets it needs none, and the runtime's `RestrictAddressFamilies` then has nothing left to allow but AF_UNIX.
- Until then, the runtime's Landlock rules (TCP transport) allow bind and connect only to the given ports, on
  kernels with Landlock ABI 4 (Linux 6.7 and later). **This bounds the destination ports, not the host, and doesn't
  cover UDP, so it is not egress confinement**: connect to port 7001 is allowed to 7001 on *any* reachable host.
  The real fence is the network namespace (or no network at all), not Landlock. Once the transport is Unix sockets,
  `landlock::restrict` is called with `Transport::Unix` and forbids TCP entirely (`network == true` then means "no
  TCP at all", which *is* confinement), allowing only the 0700 socket directory.

### 6. Medium: unchecked sizes and timeouts from the host
**Location:** `load` (`memoryMiB`), `exec` (`timeoutMs`), `new_live` (`mem_mib * 1024 * 1024`), `guarded`
(`Instant::now() + wall`).

- `memoryMiB` is checked only for `> 0`. A huge value wraps the multiplication (the heap limit becomes tiny or
  effectively unlimited).
- `timeoutMs` near `u64::MAX` panics `Instant + Duration` in the sandbox's thread.

The values come from kantel-host, which takes them from API callers.

**Fix:** clamp `memoryMiB` to 128–512 (the contract) and reject anything else with 400. Clamp `timeoutMs` to the
host's maximum. Use `checked_mul` and `checked_add`.

**W1:** forwarded.

### 7. Medium: resource exhaustion across the account
**Location:** `node_dispatch` and `py_dispatch` (a new thread per run, unbounded), `assign` (a new sandbox thread per
id, unbounded), `egress_fetch` (a new TCP connection per fetch, unbounded).

A burst of commands, or one node script doing `Promise.all` over 10,000 fetches, exhausts threads, memory or file
descriptors. That stops every sandbox of the account.

**Fix:**
- `--max-runs` and `--max-sandboxes` (both in the contract) as semaphores; past the limit, answer busy.
- Cap concurrent fetches per isolate (for example 16) and per process.
- In the VM, `TasksMax` and `LimitNOFILE` in the unit are the backstop. In native mode, the cgroup's `pids.max` is.

**W1:** forwarded.

### 8. Medium: egress passes the guest's framing, hop-by-hop headers and methods through
**Location:** `egress_fetch`.

- The guest's `content-length`, `transfer-encoding`, `connection`, `te`, `upgrade`, `keep-alive` and `trailer`
  headers, and any method including `CONNECT`, go to the egress proxy as given.
- In tests (`probes/smuggle.js`), hyper and the proxy didn't let a smuggled second request through.
- kantel-host's proxy names the sandbox from the connection's first request, and keeps every later request on that
  connection attributed to the same sandbox (`egress.go` `handleWith`). Smuggling therefore can't switch sandbox
  identity.
- A `connection: kantel-isolate-sandbox` header could make a compliant intermediary strip the tag. That fails closed
  (403).

**Fix:** drop those headers. Allow only GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. Keep dropping `kantel-*`,
`host` and `proxy-*`.

**W1:** forwarded.

### 9. Low: the budget allocator's accounting
**Location:** `b_alloc` and `b_alloc_u`.

When `calloc` or `malloc` fails after the budget check passed, `used` isn't given back. The check
`used + len > limit` can also overflow for a huge `len`.

**Fix:** `v8/patches/rusty_v8-150.4.0-budget-allocator.patch`. Its `Reserve` checks `len <= limit - used` with a
compare-and-swap and releases the bytes on failure. It is also the only allocator that works with the V8 sandbox.

**W1:** taking the allocator behind one function.

### 11. High: resizable buffers and wasm memory bypass the ArrayBuffer budget
**Location:** the budget allocator (any allocator), and the guests.

V8 serves resizable ArrayBuffers and growable SharedArrayBuffers (`new ArrayBuffer(len, { maxByteLength })`,
`new SharedArrayBuffer(len, { maxByteLength })`, `.resize()`, `.grow()`, `.transfer(biggerMax)` to a resizable
target) and WebAssembly memory from the isolate group's page allocator
(`BackingStore::TryAllocateAndPartiallyCommitMemory`), **not** through the embedder's `Allocate`/
`AllocateUninitialized`. So the per-isolate byte budget never sees them: each can be up to V8's per-buffer maximum,
and there can be many.

**Shown** against the sandboxed spike with a 256 MiB budget (`probes/budget.js`), before the fix:
- `rab-initial`, `rab-resize`, `gsab` each allocated 1200 MiB (process RSS went past 1.7 GiB), with no error.
- `plain` (fixed buffers) and `transfer` to growing fixed lengths were stopped at the budget, as they should be:
  those go through `Allocate`.

**Fix (in the guest, `guest/polyfills.js`):** wrap `ArrayBuffer` and `SharedArrayBuffer` so the constructors refuse
`maxByteLength` and `resize`/`grow` are removed, and repoint `prototype.constructor` so the species path can't reach
the native constructor. The wrapper is idempotent and is re-applied in `__node.start` and the Python lockdown,
because `SharedArrayBuffer` is added to the global only after the snapshot. After the fix, all of `rab-initial`,
`rab-resize`, `gsab` are refused with a RangeError, `transfer` is bounded by the budget, normal `ArrayBuffer`
construction and `Uint8Array` still work, and Python (`from js import ArrayBuffer`) is refused too. Wasm memory is
already capped per isolate in the spike (python caps `WebAssembly.Memory.prototype.grow`, node deletes
`WebAssembly`); keep that.

This is defence in the guest, not in the allocator: V8 gives the allocator no hook for these paths (its `Allocator`
interface in 150.4.0 has no `Reallocate` either). The allocator patch documents the limit.

**W1:** forwarded. W1 must carry the same guest guards and must not expose resizable/growable buffers or uncapped
wasm memory in any isolate kind.

### 12. Medium: a refused ArrayBuffer allocation could panic the host
**Location:** `v8/patches/deno_core-0.412.0-sandbox.patch` (the byte-module loader and buffer conversions).

My first version of the patch had the allocation helper return an empty ArrayBuffer when the budget was spent. The
byte-module loader then built a `Uint8Array` of the original length over the empty buffer and `.unwrap()`ed it, which
panics the process (finding 3's class of bug). The fallible op conversions had the same shape.

**Fix:** the helper now returns `Option`. Every call site propagates it: the byte-module loader returns a
`ModuleError::Exception` (a RangeError), `op_encode` and the `JsBuffer`/`ToJsBuffer` conversions return an error, and
the two infallible conversions (`BytesMut`, `Box<[T]>`) throw a RangeError in the isolate and answer an empty buffer
without ever building a view over it. The typed-array element helper is also restricted to a sealed trait of the
primitive number types, so a padded struct or `MaybeUninit` can't leak uninitialised bytes to a guest.

**Shown:** with the budget exhausted, importing a non-empty byte module gives the guest a RangeError and the runtime
stays healthy (the spike's `op_shared_snapshot`, which uses the same helper, returns the error path and `/healthz`
still answers).

**W1:** W1 must keep this discipline in its own copy of the patch and in any op that returns bytes.

### 10. Low: module loader and assets
- **Verified sound:** `op_read_asset` canonicalises and requires the result to be under `--assets`, so `..` and
  symlinks out are refused. The manifest's paths are keys, never file system paths. The spike's `FsModuleLoader` is
  only on for Pyodide's own module in python isolates.
- **For W1's loader:**
  - Resolve a guest's relative imports inside the sandbox's manifest, never the host's file system. Reject `..`
    above `/workspace` and absolute paths outside it.
  - Never hand a guest specifier to `FsModuleLoader`.
  - The assets cache in `op_read_asset` is unbounded by file count, but `--assets` is a fixed set.

## What this directory adds

### V8 heap sandbox (`v8/`)
- **No sandbox build exists upstream.** rusty_v8 publishes none, so `v8/build-v8-sandbox.sh` builds one: rusty_v8
  v150.4.0, commit `5c15a699`, with `v8_enable_sandbox`, pointer compression, external code space and simdutf, plus
  Kantel's allocator patch.
- **deno_core 0.412 doesn't compile with the sandbox on**, so `v8/patches/` patches it and serde_v8 (see
  `v8/README.md`).
- **Shown** with the spike built against it (`/tmp/kt-w2-spike`):
  - The process logs `v8 sandbox: true`, and `/healthz` reports `"v8Sandbox": true`.
  - Shell, node and python run.
  - The memory limit still stops runs (B5d, B5e, B5g).
  - Finding 2's snapshot write no longer reaches another sandbox.

Benchmark on the same machine, each run on a fresh server. The machine is shared, so load averages varied from 9 to
25.

| | Baseline (spike, no sandbox) | V8 sandbox + patched deno_core | Sandbox + Landlock |
| --- | --- | --- | --- |
| B4 MiB per idle sandbox | 10.9 (93 per GiB) | 8.3 (123 per GiB) | 8.2 (124 per GiB) |
| B4 RSS after unloading 50 | 590 MiB | 533 MiB | — |
| B1 warm echo median / p90 | 3.8 / 8.5 ms | 2.9 / 5.4 ms | 2.7 / 5.0 ms |
| B1 load / first echo | 25.3 / 27.4 ms | 23.9 / 29.8 ms | — |
| B2 node first / warm | 9.9 / 6.0 ms | 12.0 / 7.7 ms | 8.5 / 5.4 ms |
| B3 python first | 26.4 ms | 10.9 ms | 17.1 ms |
| B3 csv | 523 ms | 541 ms | — |
| B5 (all limits) | stopped, survived | stopped, survived | stopped, survived |
| B6 echo | 2954 ops/s | 3230 ops/s | 3161 ops/s |
| B6 node -e | 428 ops/s, p99 75 ms | 329 ops/s, p99 109 ms | 341 ops/s, p99 100 ms |
| B6 python -c | 34.2 ops/s | 30.5 ops/s | 27.1 ops/s |

What the numbers show:
- **Memory falls about 24% per idle sandbox.** Pointer compression halves tagged values.
- **Single commands are as fast or faster.**
- **Concurrent node runs lose about 20–23% throughput (B6).** Likely causes are the extra copy for every op buffer
  result, and the sandbox's checks and external pointer table on every external access. This is not profiled yet.
- **Python throughput is about 10% lower**, close to the noise of a shared machine.

### Privileges and Landlock (`hardening/`)
- **`check_privileges`:**
  - refuses root in the **real, effective and saved** uid and gid (`getresuid`/`getresgid`), so a launcher that drops
    only the effective uid but leaves the saved one 0 — from which the process could `setuid(0)` back — is caught;
  - refuses a root supplementary group (`getgroups`);
  - refuses any effective or permitted capability;
  - clears ambient capabilities;
  - sets `NO_NEW_PRIVS`;
  - sets `PR_SET_DUMPABLE=0`, so other processes of the same uid can't ptrace it or read `/proc/<pid>/mem`, and
    guest memory never goes into a core dump.
- **`landlock::restrict`** runs before the first thread:
  - read-only `--assets` (and the snapshot);
  - read-write only its own temp dir (0700);
  - read-only `/dev/urandom` (V8 opens it per isolate), `/proc/self`, the CPU, cgroup, THP and overcommit files read
    at start-up, and the time zone;
  - with `Transport::Tcp`: bind only to `--listen`'s port and connect only to the store's and egress's ports (ABI 4
    and later). This bounds the **ports, not the host**, and leaves UDP open, so it is **not** egress confinement
    (see finding 5 and the module docs);
  - with `Transport::Unix` (W1's `unix:` endpoints): **no TCP at all**, only the 0700 socket directory — which is
    confinement;
  - signals and abstract Unix sockets scoped to the process (ABI 6 and later).

  Shown on Linux 7.2 (ABI 10, "fully enforced", TCP port rules in force), by the spike's `KT_HARDEN_SELFTEST`:

  | Attempt | Result |
  | --- | --- |
  | read `/etc/hostname` | EACCES |
  | write `/tmp/x` | EACCES |
  | read `--assets` | ok |
  | write own temp dir | ok |
  | connect `127.0.0.1:29403` (not store or egress) | EACCES |
  | connect the store | ok |

  The whole benchmark passed with it on (third column above). `Report` carries `status`, `abi` and `network`;
  `network` is documented as "TCP port rules in force" for TCP transport, not egress confinement.
- **Privilege check, tested** with `KT_CHECK_PRIV=1` (a hook that runs only `check_privileges`): as my normal user it
  returns `Ok`; under `unshare --map-root-user` (real, effective and saved uid all 0) it refuses with "must not run
  as root (uids real 0, effective 0, saved 0)" and exits non-zero. The saved-uid-0-only case (effective dropped,
  saved still 0) needs `CAP_SETUID` to set up and wasn't run, but the same `getresuid` check covers it.
- **In the isolate VM:** the guest kernel is 6.1 with Firecracker's CI config. It has Landlock (`CONFIG_LSM` starts
  with `landlock`) but only ABI 2, so the file system rules apply ("partially enforced") and the TCP and scope rules
  don't. Inside the VM there is nothing else on the network to reach, so this matters less there than in native mode.
  W3 can move the guest kernel to 6.12 or later to get all of it.

### Syscall filtering
**Not delivered.** An in-process seccomp allow-list was in scope, but I couldn't complete it in this workstream.
Someone else should pick it up. The syscall trace across the benchmark is in `/tmp/kt-w2-spike/logs/strace-all.txt`
(the `strace-run.sh` method). The systemd unit has no `SystemCallFilter` for the same reason.

### systemd unit (`systemd/kantel-isolate.service`)
Replaces `kantel-workerd.service` in the isolate VM. What it sets:
- **User:** `DynamicUser`, with no capabilities, `NoNewPrivileges` and `SecureBits=noroot-locked`.
- **File system:**
  - `ProtectSystem=strict`, with `--assets` read-only;
  - `PrivateTmp`, `PrivateDevices`, `ProtectHome`;
  - `ProtectProc=invisible`, `ProcSubset=pid`.
- **Kernel and namespaces:** `ProtectKernel*`, `ProtectControlGroups`, `RestrictNamespaces`, `LockPersonality`,
  `RestrictRealtime`.
- **Network:** `RestrictAddressFamilies=AF_INET AF_UNIX`, `IPAddressAllow=localhost`, and `SocketBindAllow=tcp:8080`
  only. These work because the guest kernel has `CONFIG_CGROUP_BPF`.
- **Resources:** `MemoryMax=90%`, `MemorySwapMax=0`, `TasksMax=4096`, `LimitCORE=0`.
- **Deliberately left out:**
  - `MemoryDenyWriteExecute`, because V8's JIT needs writable then executable memory;
  - `LimitAS`, because the sandbox reserves 1 TiB of address space.

`systemd-analyze verify` passes, apart from the binary not being installed here.

## What each workstream must change

**W1 (the crate):**
1. Take `v8/`: depend on `deno_v8` with `v8_enable_sandbox`, apply `[patch.crates-io]` for deno_core and serde_v8
   from `vendor-patched.sh`, and build with `fetch-v8-sandbox.sh`'s two variables.
2. Use `kantel__BudgetAllocator__New` as the isolate's ArrayBuffer allocator, and report `v8Sandbox` from
   `v8__V8__IsSandboxEnabled` in `version` and `/healthz`.
3. Don't use the APIs listed in `v8/README.md` in its own code; copy with `serde_v8::sandbox::new_array_buffer`, which
   returns `Option`/`Result` — propagate a RangeError to the guest on `None`, never build a view over an empty buffer
   and `.unwrap()` (finding 12). Keep the typed-array element helper restricted to the sealed primitive-number trait.
4. Forbid resizable/growable buffers and uncapped wasm memory in every isolate kind (finding 11): carry the
   `guest/polyfills.js` guards (wrap `ArrayBuffer`/`SharedArrayBuffer`, re-apply at run start because
   `SharedArrayBuffer` appears after the snapshot) and keep the wasm-memory cap.
5. Include `hardening/`. Call `check_privileges(false)` first, then `landlock::restrict(&Policy { assets, temp,
   extra_read, transport })` before `JsRuntime::init_platform` or any thread; use `Transport::Unix { socket_dir }`
   once the endpoints are `unix:` paths (then no TCP is allowed at all), `Transport::Tcp { listen, connect }` meanwhile.
   Make its own temp dir 0700 first. Add `--require-landlock` (the unit passes it): exit if `restrict` reports less
   than full enforcement. Log the enforced ABI at start-up.
6. Add `unix:` support to `--listen`, `--store` and `--egress` so native mode can use Unix-socket transport (finding
   5); this is a small contract change.
7. Fix findings 1–8.

**W3 (image, host, CI):**
1. Install `systemd/kantel-isolate.service` in place of `kantel-workerd.service` in `guest/isolate.Dockerfile`. With
   `DynamicUser` there is no useradd; otherwise create `kantel-isolate`. Install the binary at
   `/usr/local/bin/kantel-isolate` and the assets at `/opt/kantel-isolate`.
2. Native mode (finding 5): Unix sockets in `r.dir`, a uid per account, a cgroup with `memory.max` and `pids.max`
   (`UseCgroupFD`), and a network namespace. Also drop the listen-close-reuse port pick.
3. CI: publish the sandboxed V8 as a release asset and fetch it with `fetch-v8-sandbox.sh` plus `actions/cache`
   (`v8/README.md` has the steps and a workflow).
4. Optionally move the isolate VM's guest kernel to 6.12 or later for Landlock's network and scope rules.

## Review follow-ups implemented in the runtime (W1)

A later independent review of the runtime raised further items; these are fixed in the crate with a regression
test each (`test/integration.test.ts`, run on both the stock and `v8-sandbox` builds):

- **Heap guard after a reused isolate (H1):** a shell isolate terminated for CPU/memory is reused, so its one-shot
  near-heap callback is re-armed, and the watchdog no longer skips an isolate whose budget is marked exceeded —
  repeated breaches and a following CPU loop all stay contained.
- **Guest-mutable intrinsics (H2):** the buffer and wasm guards use primordials captured at snapshot time
  (`guest/common/primordials.js`), so replacing `Reflect.construct` or `WeakMap.prototype.get` can't smuggle a
  resizable buffer past the guard or fake a wasm-growth reservation.
- **Python wasm lockdown (H3):** the wasm guard's boot mode is ended once Pyodide is up and before any user code, and
  `SharedArrayBuffer` is wrapped before it is deleted, so Python can't make a shared/growable memory.
- **Host-returned buffers are budgeted (H4):** file reads, fetch bodies and `core.encode` copies are charged to the
  isolate's memory in stock builds (the in-sandbox allocator charges them in `v8-sandbox` builds).
- **Fetch memory (H5):** concurrency is 8 per isolate, response bytes are charged as they arrive against the isolate
  and a process-wide in-flight cap, and the spawned I/O is aborted when the run ends.
- **Capacity (H6):** `--max-sandboxes` evicts only idle sessions and answers a retryable `503` when full; an
  executing sandbox is never evicted.
- **STORE reads (M7)** are capped at the sandbox's memory, separate from the egress body cap.
- **`process.exit` (H8)** ends the child run at once (pending timers stop).
- **Child terminations (H9)** carry `terminated` through to `/exec`.
- **Cross-origin redirects (M10)** drop `Authorization`/`Cookie`; same-origin redirects keep them.
- **build-assets.sh (M11)** uses a frozen install (never a plain fallback), honours `KANTEL_ISOLATE_OFFLINE`, and
  pins the Pyodide tarball's SHA-256 (checked before extraction).
- **One memory limit:** memoryMiB used to bound the V8 heap and ArrayBuffers + wasm memory each, so an isolate could
  hold about twice its size. A GC epilogue now records the heap after every GC into the isolate's budget; buffer and
  wasm requests are refused past memoryMiB minus the heap, and the epilogue terminates (`terminated: memory`) when
  heap + buffers + wasm is over memoryMiB at a full GC and the GC after it. In `v8-sandbox` builds the C++ budget
  allocator's byte count (`kantel__BudgetAllocator__Used`) is read into the same sum; the allocator's own limit
  stays memoryMiB, so no V8 rebuild was needed. The heap limit stays memoryMiB as the backstop. If no GC follows the
  full GC that found the total over (the program stopped allocating), the watchdog stops the isolate when it is still
  over 200 ms later. Tested in the shell, node and python, heap-then-buffers and the reverse, on both builds. An
  independent review of this change also found, and these are fixed: a refused request was counted for a moment
  before it was rolled back (a concurrent GC could act on it); a watchdog termination could land after a command
  had cancelled its own and the isolate was being dropped (stopping and finishing are now serialised); and
  reloading a sandbox with another memory size made the new isolate before dropping the old one (rusty_v8 needs the
  reverse).
  Speed (the spike's bench, B2/B3, two rounds each, before → after, same machine, load 7–10): no cost beyond the
  noise.

  | ms | stock before | stock after | sandbox before | sandbox after |
  | --- | --- | --- | --- | --- |
  | B2 node first | 11.9, 12.8 | 10.8, 11.5 | 13.5, 11.0 | 13.2, 11.9 |
  | B2 node warm median | 10.8, 9.6 | 12.7, 12.0 | 11.7, 11.7 | 12.1, 10.5 |
  | B2 file script | 25.4, 21.1 | 22.6, 18.5 | 21.4, 20.3 | 23.4, 23.8 |
  | B3 python first | 32.7, 39.5 | 34.7, 32.2 | 30.7, 36.6 | 32.2, 27.5 |
  | B3 python warm (600 ms apart) median | 22.3, 22.8 | 23.8, 23.3 | 22.3, 22.8 | 21.7, 23.4 |
  | B3 csv | 560, 561 | 594, 562 | 581, 540 | 584, 529 |

- **A terminated shell command could hang `/exec` for good:** when a termination lands in a timer callback or an
  event-loop tick, deno_core swallows it and loses the timer schedule, so the command's promise never settles (seen
  on the earlier build too, e.g. a CPU-limit stop while `wc` read a 120 MB file; the wall deadline didn't help,
  since only JavaScript is terminated). The shell now abandons such a call after a 1 s grace and replaces its
  isolate, dropping it outside the event loop (inside, V8 aborts).
- **Unix-socket transport is tested:** a subset of the suite runs with `--listen`, `--store` and `--egress` on Unix
  sockets in a 0700 directory and checks that the process has no TCP or UDP socket while a guest fetch still reaches
  the egress socket.
