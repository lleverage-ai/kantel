# V8 with its heap sandbox, for kantel-isolate

The default rusty_v8 build that deno_core uses has no V8 heap sandbox (`v8_enable_sandbox` off, no pointer
compression). workerd's build has one. This directory turns it on for kantel-isolate.

| File | What it is |
| --- | --- |
| `build-v8-sandbox.sh` | Builds rusty_v8 150.4.0 (the `v8` deno_core 0.412 uses, through `deno_v8` 0.4) with `v8_enable_sandbox` and `simdutf`, plus Kantel's allocator patch, in Docker. About 17 minutes on 20 cores, 5 GB of disk. |
| `fetch-v8-sandbox.sh` | Downloads the published build, checks the SHA-256s pinned in it, prints `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH`. |
| `vendor-patched.sh` | Writes deno_core 0.412.0 and serde_v8 0.321.0 with the sandbox patches into a directory, for `[patch.crates-io]`. |
| `patches/rusty_v8-150.4.0-budget-allocator.patch` | rusty_v8's `binding.cc`: `KantelBudgetAllocator` (a per-isolate ArrayBuffer budget that allocates through V8's default allocator, so inside the sandbox) and `kantel__ArrayBuffer__NewBackingStore__or_null` (a fallible allocation). |
| `patches/deno_core-0.412.0-sandbox.patch`, `patches/serde_v8-0.321.0-sandbox.patch` | deno_core and serde_v8 without the APIs a sandbox build leaves out. |

## Why deno_core needs patching

A V8 sandbox build requires every ArrayBuffer backing store to be inside the sandbox. rusty_v8 therefore leaves out
`new_backing_store_from_vec`, `_from_boxed_slice`, `_from_bytes` and `new_rust_allocator` when `v8_enable_sandbox` is
on, and deno_core 0.412 doesn't compile without them. The patches change these places:

- **deno_core's buffer conversions** (op results of `Vec<u8>`/`Box<[T]>`/`BytesMut`, `op_encode`, byte modules) and
  **serde_v8's `ToJsBuffer`** now copy into a store from the isolate's own allocator (`serde_v8::sandbox`). The cost
  is one copy per buffer. The bytes now count against the isolate's budget. When the budget is spent, the isolate
  gets a RangeError instead of V8 crashing the process.
- **deno_core's `ContextState` tick, immediate and timer info** were Boxes on Rust's heap, handed to JS with
  `new_backing_store_from_ptr`. Under the sandbox that is a fatal check failure. Without it, JS could write to Rust's
  heap. They are now V8-allocated stores (`SharedInfo`) that Rust reads through.

Any code in kantel-isolate itself must do the same. Use `deno_core::serde_v8::sandbox::new_array_buffer(scope,
bytes)` to give JS bytes; it returns `Option` (`None` when the isolate's budget is spent), so propagate a RangeError
to the guest instead of building a view over an empty buffer and `.unwrap()`ing it. Never use
`new_backing_store_from_ptr` on memory V8 didn't allocate.

The budget allocator only bounds fixed-size ArrayBuffers (the `Allocate` path). Resizable/growable ArrayBuffers and
WebAssembly memory come from V8's page allocator and bypass it, so kantel-isolate forbids them in the guest (see
`SECURITY.md`, findings 11). Keep those guards.

## Using it in the crate (W1)

```toml
[dependencies]
deno_core = "0.412"
deno_v8 = { version = "0.4", features = ["v8_enable_sandbox"] }   # turns it on in rusty_v8 through deno_core's facade

[patch.crates-io]
deno_core = { path = "vendor/deno_core-0.412.0" }   # apps/host/isolate-runtime/v8/vendor-patched.sh vendor
serde_v8 = { path = "vendor/serde_v8-0.321.0" }
```

```rust
unsafe extern "C" {
    fn kantel__BudgetAllocator__New(limit: usize) -> *mut v8::Allocator;
    fn kantel__BudgetAllocator__Used(a: *const v8::Allocator) -> usize;
    fn v8__V8__IsSandboxEnabled() -> bool;   // already in rusty_v8's binding.cc; Rust only declares it in its tests
}
let alloc = unsafe { v8::UniquePtr::from_raw(kantel__BudgetAllocator__New(mem_mib << 20)) }.unwrap();
let params = v8::CreateParams::default().heap_limits(0, mem_mib << 20).array_buffer_allocator(alloc);
```

`kantel-isolate version` reports `"v8Sandbox": unsafe { v8__V8__IsSandboxEnabled() }`.

Build with:

```sh
eval "$(apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh --export ~/.cache/kantel-v8)" && cargo build --release
```

The patched crates need these Kantel symbols, so they link only against this build, not rusty_v8's prebuilt archives.

All isolates in a process share one 4 GiB pointer-compression cage (the shared cage, which the sandbox requires). That
caps the JS heap of all of an account's isolates together at about 4 GiB. ArrayBuffers and wasm memory sit outside the
cage, in the 1 TiB sandbox reservation. The reservation is address space, not memory: never set `LimitAS`/`RLIMIT_AS`
on the process.

## Builds, release and CI (W3)

denoland/rusty_v8 publishes no sandbox build, so Kantel builds one per `v8` crate version and patch revision and
publishes the files as a prerelease of this repository, `rusty-v8-sandbox-v<version>-<revision>` (now
`rusty-v8-sandbox-v150.4.0-1`). `fetch-v8-sandbox.sh` pins each file's SHA-256 and downloads from there.

| Target | Built | Proven |
| --- | --- | --- |
| `x86_64-unknown-linux-gnu` | natively on an x86_64 host, about 17 minutes at 20 jobs | kantel-isolate's test and integration suites |
| `aarch64-unknown-linux-gnu` | cross-compiled on an x86_64 host (`TARGET=aarch64-unknown-linux-gnu`), about 36 minutes at 16 jobs | under QEMU user emulation: `version` reports `"v8Sandbox": true`, and a shell, `node -e` and `python -c` run. Not yet on arm64 hardware. |

Both build on x86_64 only. rusty_v8's build script downloads Chromium's clang, and Chromium publishes no Linux arm64
clang, so aarch64 is cross-compiled, as rusty_v8's own CI does: V8 against Chromium's debian_sid arm64 sysroot, and
bindgen against Debian's aarch64 glibc headers. The bindings (`src_binding_*.rs`) come out byte-identical for the two
targets.

`apps/host/guest/isolate-runtime.sh <amd64|arm64>` with `KANTEL_V8_SANDBOX=1` fetches the target's files
(`KANTEL_V8_TARGET` tells `fetch-v8-sandbox.sh` which, when it isn't this machine's) and links them, for the isolate
VM's image on either architecture.

### Rebuild (a `v8` bump or a patch change)

1. Bump the revision in `fetch-v8-sandbox.sh`'s `TAG` (or `V8_CRATE_VERSION`, with `build-v8-sandbox.sh`'s pins): a
   rebuild isn't bit-for-bit reproducible (the toolchain downloads), so new files never replace pinned ones in place.
2. Build both targets, with the workflow or by hand:
   - **Workflow** (`.github/workflows/rusty-v8-sandbox.yml`, run by hand): builds both targets on the self-hosted
     runners and uploads them with a combined `SHA256SUMS` to the release named by its `tag` input, creating the
     prerelease if it's missing. It doesn't overwrite an existing file unless `replace` is set. GitHub runs a
     `workflow_dispatch` workflow only once the file is on the default branch, so it can't be run until it's merged to
     `main` (until then, build by hand).
   - **By hand**: `build-v8-sandbox.sh out-x64` and `TARGET=aarch64-unknown-linux-gnu build-v8-sandbox.sh out-arm64`,
     then `gh release create <tag> --prerelease` and `gh release upload <tag>` the `.a.gz`, `.rs` and `.gn` files
     with one `SHA256SUMS` covering both (each out dir's own `SHA256SUMS` has the same name, so combine them).
3. Copy the SHA-256s into `fetch-v8-sandbox.sh` in the same PR. The pinned checksums are what make a download
   trustworthy, not a rebuild.

### Use in CI

Any job that builds kantel-isolate:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/kantel-v8
          key: kantel-v8-${{ runner.arch }}-${{ hashFiles('apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh') }}
      - run: apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh ~/.cache/kantel-v8 >> "$GITHUB_ENV"
      - run: apps/host/isolate-runtime/v8/vendor-patched.sh apps/host/isolate-runtime/vendor   # unless vendored in git
      - run: cargo build --release --locked
        working-directory: apps/host/isolate-runtime
```

or, as ci.yml and sandbox-image.yml do, `KANTEL_V8_SANDBOX=1 apps/host/guest/isolate-runtime.sh <arch>`.
`RUSTY_V8_MIRROR` doesn't fit this setup, because it expects rusty_v8's own `v<version>/` tag layout.
