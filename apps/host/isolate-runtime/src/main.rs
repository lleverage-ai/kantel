//! kantel-isolate: Kantel's isolate runtime on deno_core. See README.md and CONTRACT.md.

mod bridges;
mod config;
#[path = "../hardening/mod.rs"]
mod hardening;
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

/// Whether this binary's V8 has the heap sandbox on. With `--features v8-sandbox` it asks V8 (W2's build); otherwise
/// it is off.
#[cfg(feature = "v8-sandbox")]
fn v8_sandbox_enabled() -> bool {
    unsafe extern "C" {
        fn v8__V8__IsSandboxEnabled() -> bool;
    }
    // SAFETY: a pure query into V8; valid after init_platform.
    unsafe { v8__V8__IsSandboxEnabled() }
}
#[cfg(not(feature = "v8-sandbox"))]
fn v8_sandbox_enabled() -> bool {
    false
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
            let v8_sandbox = v8_sandbox_enabled();
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
            // Before any thread starts: refuse privileges, then apply Landlock (it binds this thread and the ones it
            // starts afterwards, so it must run before the tokio runtime and the pools).
            harden(&cfg, args.require_landlock, args.allow_root, &args.seccomp)?;
            // Only now: jemalloc's background threads (purging freed memory) start hardened, like every other thread.
            #[cfg(feature = "jemalloc")]
            if let Err(e) = tikv_jemalloc_ctl::background_thread::write(true) {
                tracing::warn!(error = %e, "jemalloc background threads not started; freed memory is purged inline");
            }
            init_v8();
            serve(cfg)
        }
    }
}

/// Process hardening (W2's module): no root/capabilities, non-dumpable, then a Landlock policy that allows only
/// `--assets` (read), a private temp dir (read-write), the few system files V8/jemalloc read, and either the Unix
/// socket directory (no TCP at all) or the store/egress/listen TCP ports.
fn harden(cfg: &config::Config, require_landlock: bool, allow_root: bool, seccomp: &str) -> Result<()> {
    hardening::check_privileges(allow_root)?;
    let temp = std::env::temp_dir().join(format!("kantel-isolate-{}", std::process::id()));
    std::fs::create_dir_all(&temp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700));
    }
    let transport = transport_of(cfg);
    let policy = hardening::landlock::Policy {
        assets: cfg.assets.clone(),
        temp,
        extra_read: vec![],
        transport,
    };
    let report = hardening::landlock::restrict(&policy)?;
    tracing::info!(status = report.status, abi = report.abi, network = report.network, "landlock");
    // --require-landlock fails closed when Landlock enforces nothing. An older ABI (the isolate VM's Linux 6.1 has
    // ABI 2) still enforces the file-system rules but not the TCP-port ones: that's accepted with a warning, because
    // the network is fenced elsewhere — the VM has no network device, and with Unix-socket transport (native mode)
    // the seccomp filter below allows no TCP or UDP socket at all, on any kernel.
    if report.status.starts_with("not enforced") {
        if require_landlock {
            anyhow::bail!("--require-landlock: Landlock is {} on this kernel", report.status);
        }
        tracing::warn!(status = report.status, "landlock: the runtime runs without its file-system rules");
    } else if report.status != "fully enforced" {
        tracing::warn!(status = report.status, abi = report.abi, "landlock: file-system rules only; the network is fenced by seccomp and the VM");
    }
    // Last, still before any thread: every thread V8, tokio and the pools start inherits the filter.
    if seccomp == "off" {
        tracing::warn!("seccomp: off (--seccomp off): the runtime runs without its syscall filter");
    } else {
        let sockets = match transport_of(cfg) {
            hardening::landlock::Transport::Unix { .. } => hardening::seccomp::Sockets::UnixOnly,
            hardening::landlock::Transport::Tcp { .. } => hardening::seccomp::Sockets::UnixAndIpv4,
        };
        let report = hardening::seccomp::install(seccomp.parse()?, sockets)?;
        tracing::info!(%report, "seccomp");
    }
    Ok(())
}

/// The Landlock transport: Unix (no TCP) when `--listen`, `--store` and `--egress` are all Unix sockets, else TCP
/// with the ports the runtime binds and connects to.
fn transport_of(cfg: &config::Config) -> hardening::landlock::Transport {
    use bridges::Target;
    let listen_unix = cfg.listen.strip_prefix("unix:");
    if let (Some(listen), Target::Unix(store), Target::Unix(egress)) = (listen_unix, &cfg.store, &cfg.egress) {
        // The sockets share one 0700 directory (kantel-host's per-account dir); allow that directory.
        let dir = std::path::Path::new(listen)
            .parent()
            .or_else(|| store.parent())
            .or_else(|| egress.parent())
            .unwrap_or_else(|| std::path::Path::new("/run/kantel-isolate"))
            .to_path_buf();
        let _ = egress;
        return hardening::landlock::Transport::Unix { socket_dir: dir };
    }
    let port = |t: &Target| match t {
        Target::Tcp(a) => a.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()),
        Target::Unix(_) => None,
    };
    let listen = cfg.listen.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
    let connect = [port(&cfg.store), port(&cfg.egress)].into_iter().flatten().collect();
    hardening::landlock::Transport::Tcp { listen, connect }
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
