//! kantel-isolate as a library: the V8 isolate runtime (a just-bash shell, `node` and `python`, one isolate each, on
//! deno_core) that the `kantel-isolate` binary serves over Kantel's isolate protocol, for other programs to embed.
//!
//! An embedder starts one [`Engine`] per process with an [`Embedding`] (its guest bundle and its own ops), then runs
//! sandboxes with [`isolate::spawn_shell`]. [`EMBEDDING.md`](https://github.com/lleverage-ai/kantel/blob/main/apps/host/isolate-runtime/EMBEDDING.md)
//! is the contract: what a guest bundle must define, what the runtime's ops and limits guarantee, and what may change.
//!
//! ```no_run
//! use kantel_isolate::{Config, Embedding, Engine};
//!
//! # fn main() -> anyhow::Result<()> {
//! // The guest bundle defines `globalThis.__kantel.init(kind)` (EMBEDDING.md); Kantel's is guest/dist/guest.js.
//! const GUEST: &str = "globalThis.__kantel = { init(kind) { /* ... */ } };";
//! kantel_isolate::init_v8();
//! let io = tokio::runtime::Runtime::new()?;
//! Engine::init(Config::new("/opt/kantel-isolate".into()), Embedding::new(GUEST), io.handle().clone(), false)?;
//! let shell = kantel_isolate::isolate::spawn_shell("sandbox-1".into(), 256, false);
//! # Ok(())
//! # }
//! ```

pub mod bridges;
pub mod config;
pub mod embed;
pub mod harden;
#[path = "../hardening/mod.rs"]
pub mod hardening;
pub mod hostbuf;
pub mod isolate;
pub mod limits;
mod ops;
pub mod server;
mod transpile;
mod wasm;

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub use config::Config;
pub use embed::Embedding;
pub use isolate::{Ctx, Engine, Kind, engine};

/// Entropy mixed into V8's per-isolate RNG seed on top of the OS source, set by /reseed after a VM restore.
static EXTRA_ENTROPY: Mutex<[u8; 32]> = Mutex::new([0; 32]);
static SEED_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Mix `bytes` into every isolate made from now on's RNG seed (after a VM is restored from a template snapshot, so
/// VMs restored from one template diverge).
pub fn seed_entropy(bytes: &[u8]) {
    let mut extra = EXTRA_ENTROPY.lock().unwrap();
    for (i, b) in bytes.iter().enumerate().take(32) {
        extra[i] ^= b;
    }
}

/// V8 asks this for every isolate's RNG seed. OS entropy (getrandom), mixed with any /reseed entropy and a counter,
/// so two VMs restored from one template never share Math.random state once their isolates are rebuilt.
fn entropy_source(buf: &mut [u8]) -> bool {
    if getrandom::fill(buf).is_err() {
        return false;
    }
    let extra = *EXTRA_ENTROPY.lock().unwrap();
    let counter = SEED_COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes();
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= extra[i % 32] ^ counter[i % 8];
    }
    true
}

/// Whether this build's V8 has the heap sandbox on. With `--features v8-sandbox` it asks V8 (W2's build); otherwise
/// it is off.
#[cfg(feature = "v8-sandbox")]
pub fn v8_sandbox_enabled() -> bool {
    unsafe extern "C" {
        fn v8__V8__IsSandboxEnabled() -> bool;
    }
    // SAFETY: a pure query into V8; valid after init_platform.
    unsafe { v8__V8__IsSandboxEnabled() }
}
/// Whether this build's V8 has the heap sandbox on: never, without the `v8-sandbox` feature.
#[cfg(not(feature = "v8-sandbox"))]
pub fn v8_sandbox_enabled() -> bool {
    false
}

/// Initialise V8 for the process: its entropy source, the runtime's flags and the platform. Call once, before
/// [`Engine::init`] and before any isolate is made, after the process has hardened itself (V8's platform starts
/// threads, which should inherit the hardening).
pub fn init_v8() {
    // Must be set before V8 initialises, so every isolate (including the snapshot's) seeds its RNG from the OS.
    deno_core::v8::V8::set_entropy_source(entropy_source);
    // A backstop on wasm memory across the process: no single wasm memory may exceed 512 MiB (kantel-host's largest
    // isolate); the per-isolate accounting (guest wasm guard + host budget) is the real limit. Also try to turn off
    // resizable ArrayBuffers / growable SharedArrayBuffers at the engine (they allocate outside the ArrayBuffer
    // budget); the guest's buffer guard is the portable fence, and the V8 flag a backstop where it still exists.
    let leftover = deno_core::v8_set_flags(vec![
        "kantel-isolate".into(),
        "--wasm-max-mem-pages=8192".into(),
        "--no-harmony-rab-gsab".into(),
        "--no-js-rab-gsab".into(),
    ]);
    // v8_set_flags returns the args it didn't recognise (the program name, plus any flag this V8 dropped).
    if leftover.len() > 1 {
        tracing::debug!("V8 ignored flags: {:?}", &leftover[1..]);
    }
    deno_core::JsRuntime::init_platform(None);
}

/// `{"version", "v8", "v8Sandbox", "unixSockets", "transports"}`: what `kantel-isolate version` prints and what
/// kantel-host reads to choose a transport. Call after [`init_v8`].
pub fn version_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "v8": deno_core::v8::V8::get_version(),
        "v8Sandbox": v8_sandbox_enabled(),
        "unixSockets": true,
        "transports": ["tcp", "unix"],
    })
}
