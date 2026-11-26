//! kantel-isolate: Kantel's isolate runtime on deno_core. See README.md and CONTRACT.md. The runtime itself is the
//! library (src/lib.rs); this binary is its command line, Kantel's guest bundle and process allocator.

mod cli;

use anyhow::{Result, anyhow};
use cli::{Cli, Cmd, LogFormat};
use kantel_isolate::{Config, Embedding, harden, isolate, server};

// jemalloc for the whole process (V8 included): it returns freed memory to the OS and doesn't serialise the many
// isolate threads the way glibc with few arenas does. Off with `--no-default-features` (e.g. under a different
// global allocator); the runtime works either way.
#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// Kantel's guest bundle (the shell, node and python runtimes), compiled in: build it with `bun run guest/build.ts`
/// before `cargo build`.
const GUEST: &str = include_str!("../guest/dist/guest.js");

fn kantel() -> Embedding {
    Embedding::new(GUEST)
}

fn setup_logging(format: LogFormat) {
    use tracing_subscriber::fmt;
    let env = tracing_subscriber::EnvFilter::try_from_env("KANTEL_ISOLATE_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    match format {
        LogFormat::Json => fmt()
            .json()
            .with_env_filter(env)
            .with_current_span(false)
            .init(),
        LogFormat::Text => fmt().with_env_filter(env).init(),
    }
}

fn main() -> Result<()> {
    let cli = <Cli as clap::Parser>::parse();
    match cli.command {
        Cmd::Version => {
            kantel_isolate::init_v8();
            println!("{}", kantel_isolate::version_info());
            Ok(())
        }
        Cmd::PythonSnapshot { assets, out } => {
            kantel_isolate::init_v8();
            let assets = std::fs::canonicalize(&assets)
                .map_err(|e| anyhow!("--assets {}: {e}", assets.display()))?;
            let cfg = Config {
                store: kantel_isolate::bridges::Target::Tcp("127.0.0.1:0".into()),
                egress: kantel_isolate::bridges::Target::Tcp("127.0.0.1:0".into()),
                python_snapshot: out.clone(),
                pool: 0,
                node_pool: 0,
                python_pool: 0,
                max_sandboxes: 1,
                max_runs: 1,
                idle: std::time::Duration::from_secs(60),
                ..Config::new(assets)
            };
            setup_logging(LogFormat::Text);
            let io = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            isolate::Engine::init(
                cfg,
                kantel(),
                io.handle().clone(),
                std::env::var("KANTEL_ISOLATE_DEBUG").is_ok(),
            )?;
            isolate::make_python_snapshot(&out)?;
            eprintln!("wrote {}", out.display());
            Ok(())
        }
        Cmd::Serve(args) => {
            let cfg = cli::config(&args)?;
            setup_logging(args.log_format);
            // Before any thread starts: refuse privileges, then apply Landlock (it binds this thread and the ones it
            // starts afterwards, so it must run before the tokio runtime and the pools).
            let policy = harden::HardeningPolicy::kantel(
                args.require_landlock,
                args.allow_root,
                &args.seccomp,
            )?;
            harden::harden(&cfg, &policy)?;
            // Only now: jemalloc's background threads (purging freed memory) start hardened, like every other thread.
            #[cfg(feature = "jemalloc")]
            if let Err(e) = tikv_jemalloc_ctl::background_thread::write(true) {
                tracing::warn!(error = %e, "jemalloc background threads not started; freed memory is purged inline");
            }
            kantel_isolate::init_v8();
            server::serve(cfg, kantel())
        }
    }
}
