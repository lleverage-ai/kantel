//! kantel-isolate: Kantel's isolate runtime on deno_core. See README.md and CONTRACT.md.

mod bridges;
mod config;
mod isolate;
mod limits;
mod ops;
mod server;
mod transpile;
mod wasm;

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Result, anyhow};
use config::{Cli, Cmd, LogFormat};

// jemalloc for the whole process (V8 included): it returns freed memory to the OS and doesn't serialise the many
// isolate threads the way glibc with few arenas does. Off with `--no-default-features` (e.g. under a different
// global allocator); the runtime works either way.
#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// Entropy mixed into V8's per-isolate RNG seed on top of the OS source, set by /reseed after a VM restore.
static EXTRA_ENTROPY: Mutex<[u8; 32]> = Mutex::new([0; 32]);
static SEED_COUNTER: AtomicU64 = AtomicU64::new(0);

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

fn init_v8() {
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

fn setup_logging(format: LogFormat) {
    use tracing_subscriber::fmt;
    let env = tracing_subscriber::EnvFilter::try_from_env("KANTEL_ISOLATE_LOG").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    match format {
        LogFormat::Json => fmt().json().with_env_filter(env).with_current_span(false).init(),
        LogFormat::Text => fmt().with_env_filter(env).init(),
    }
}

fn main() -> Result<()> {
    let cli = <Cli as clap::Parser>::parse();
    match cli.command {
        Cmd::Version => {
            init_v8();
            let v8_sandbox = cfg!(feature = "v8-sandbox");
            println!(
                "{}",
                serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "v8": deno_core::v8::V8::get_version(), "v8Sandbox": v8_sandbox, "unixSockets": true, "transports": ["tcp", "unix"] })
            );
            Ok(())
        }
        Cmd::PythonSnapshot { assets, out } => {
            init_v8();
            let assets = std::fs::canonicalize(&assets).map_err(|e| anyhow!("--assets {}: {e}", assets.display()))?;
            let cfg = config::Config {
                listen: String::new(),
                store: bridges::Target::Tcp("127.0.0.1:0".into()),
                egress: bridges::Target::Tcp("127.0.0.1:0".into()),
                pyodide: assets.join("pyodide"),
                python_snapshot: out.clone(),
                assets,
                pool: 0,
                node_pool: 0,
                python_pool: 0,
                cpu: std::time::Duration::from_secs(120),
                max_sandboxes: 1,
                max_runs: 1,
                log_format: LogFormat::Text,
                idle: std::time::Duration::from_secs(60),
            };
            setup_logging(LogFormat::Text);
            let io = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
            isolate::Engine::init(cfg, io.handle().clone(), std::env::var("KANTEL_ISOLATE_DEBUG").is_ok())?;
            isolate::make_python_snapshot(&out)?;
            eprintln!("wrote {}", out.display());
            Ok(())
        }
        Cmd::Serve(args) => {
            let cfg = config::Config::from_args(&args)?;
            setup_logging(cfg.log_format);
            init_v8();
            serve(cfg)
        }
    }
}

fn serve(cfg: config::Config) -> Result<()> {
    let debug = std::env::var("KANTEL_ISOLATE_DEBUG").is_ok();
    // Hand freed malloc memory back to the OS every few seconds: isolates come and go on many threads, and glibc
    // otherwise keeps what they freed (jemalloc with background_threads does this itself, but the trim is harmless).
    if cfg!(not(feature = "jemalloc")) {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                unsafe { libc::malloc_trim(0) };
            }
        });
    }
    let io = tokio::runtime::Builder::new_multi_thread().worker_threads(8).enable_all().build()?;
    let handle = io.handle().clone();
    isolate::Engine::init(cfg.clone(), handle, debug)?;
    // Fill the node/python ready pools.
    isolate::node_refill();
    isolate::python_refill();
    io.block_on(async move {
        let app = server::App::new(cfg.clone());
        {
            // Pre-load the shell pool.
            let a = app.clone();
            tokio::task::spawn_blocking(move || server::warm_pool(&a)).await.ok();
        }
        let router = server::router(app);
        tracing::info!(listen = %cfg.listen, store = %cfg.store.describe(), egress = %cfg.egress.describe(), "kantel-isolate listening");
        if let Some(path) = cfg.listen.strip_prefix("unix:") {
            // Replace a stale socket; kantel-host owns the 0700 directory it lives in.
            let _ = std::fs::remove_file(path);
            let listener = tokio::net::UnixListener::bind(path)?;
            axum::serve(listener, router).with_graceful_shutdown(shutdown()).await?;
        } else {
            let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
            axum::serve(listener, router).with_graceful_shutdown(shutdown()).await?;
        }
        Ok(())
    })
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
