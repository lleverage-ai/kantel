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
- Until then, the runtime's Landlock rules allow TCP connect only to the store and egress ports and bind only to its
  own, on kernels with Landlock ABI 4 (Linux 6.7 and later). This alone closes the other-account ports, but not on
  older host kernels.

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
  - refuses root and any effective or permitted capability;
  - clears ambient capabilities;
  - sets `NO_NEW_PRIVS`;
  - sets `PR_SET_DUMPABLE=0`, so other processes of the same uid can't ptrace it or read `/proc/<pid>/mem`, and
    guest memory never goes into a core dump.
- **`landlock::restrict`** runs before the first thread:
  - read-only `--assets` (and the snapshot);
  - read-write only its own temp dir (0700);
  - read-only `/dev/urandom` (V8 opens it per isolate), `/proc/self`, the CPU, cgroup, THP and overcommit files read
    at start-up, and the time zone;
  - TCP bind only to `--listen`'s port and connect only to the store's and egress's ports (ABI 4 and later);
  - signals and abstract Unix sockets scoped to the process (ABI 6 and later).

  Shown on Linux 7.2 (ABI 10, "fully enforced, network: true"), by the spike's `KT_HARDEN_SELFTEST`:

  | Attempt | Result |
  | --- | --- |
  | read `/etc/hostname` | EACCES |
  | write `/tmp/x` | EACCES |
  | read `--assets` | ok |
  | write own temp dir | ok |
  | connect `127.0.0.1:29403` (not store or egress) | EACCES |
  | connect the store | ok |

  The whole benchmark passed with it on (third column above).
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
3. Don't use the APIs listed in `v8/README.md` in its own code; copy with `serde_v8::sandbox::new_array_buffer`.
4. Include `hardening/`. Call `check_privileges(false)` first, then `landlock::restrict(&Policy { assets, temp,
   listen_port, connect_ports: [store, egress] })` before `JsRuntime::init_platform` or any thread. Make its own temp
   dir 0700 first. Add `--require-landlock` for production.
5. Fix findings 1–8.

**W3 (image, host, CI):**
1. Install `systemd/kantel-isolate.service` in place of `kantel-workerd.service` in `guest/isolate.Dockerfile`. With
   `DynamicUser` there is no useradd; otherwise create `kantel-isolate`. Install the binary at
   `/usr/local/bin/kantel-isolate` and the assets at `/opt/kantel-isolate`.
2. Native mode (finding 5): Unix sockets in `r.dir`, a uid per account, a cgroup with `memory.max` and `pids.max`
   (`UseCgroupFD`), and a network namespace. Also drop the listen-close-reuse port pick.
3. CI: publish the sandboxed V8 as a release asset and fetch it with `fetch-v8-sandbox.sh` plus `actions/cache`
   (`v8/README.md` has the steps and a workflow).
4. Optionally move the isolate VM's guest kernel to 6.12 or later for Landlock's network and scope rules.
