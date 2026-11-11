//! Command line: `kantel-isolate serve|version|python-snapshot`. Every flag also reads KANTEL_ISOLATE_<FLAG>.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};

use crate::bridges::Target;

#[derive(Parser, Debug)]
#[command(name = "kantel-isolate", version, about = "Kantel's isolate runtime (deno_core)")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Serve kantel-host's isolate protocol (GET /healthz, POST /warm, /load, /exec, /unload).
    Serve(Box<ServeArgs>),
    /// Print {"version", "v8", "v8Sandbox"} as JSON.
    Version,
    /// Make the Pyodide memory snapshot (build-assets.sh runs this): boots Pyodide from --assets, writes --out.
    PythonSnapshot {
        #[arg(long, env = "KANTEL_ISOLATE_ASSETS")]
        assets: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LogFormat {
    Json,
    Text,
}

#[derive(clap::Args, Debug, Clone)]
pub struct ServeArgs {
    /// Address to serve on: `host:port` or `unix:/absolute/path`.
    #[arg(long, env = "KANTEL_ISOLATE_LISTEN", default_value = "127.0.0.1:8080")]
    pub listen: String,
    /// The host's blob store bridge (GET /blobs/<sha>, PUT /blobs): an http:// URL, host:port, or `unix:/path`.
    #[arg(long, env = "KANTEL_ISOLATE_STORE", default_value = "http://127.0.0.1:7001")]
    pub store: String,
    /// The host's egress proxy bridge (proxy-style HTTP): an http:// URL, host:port, or `unix:/path`.
    #[arg(long, env = "KANTEL_ISOLATE_EGRESS", default_value = "http://127.0.0.1:7002")]
    pub egress: String,
    /// The directory build-assets.sh made.
    #[arg(long, env = "KANTEL_ISOLATE_ASSETS", default_value = "/opt/kantel-isolate")]
    pub assets: PathBuf,
    /// Shell isolates kept pre-loaded for new sandboxes (POST /warm changes it).
    #[arg(long, env = "KANTEL_ISOLATE_POOL", default_value_t = 2)]
    pub pool: usize,
    /// Fresh node isolates kept ready.
    #[arg(long, env = "KANTEL_ISOLATE_NODE_POOL", default_value_t = 2)]
    pub node_pool: usize,
    /// Booted Python isolates kept ready (each holds Pyodide, about 60 MiB).
    #[arg(long, env = "KANTEL_ISOLATE_PYTHON_POOL", default_value_t = 1)]
    pub python_pool: usize,
    /// CPU per command, its node and python runs included.
    #[arg(long, env = "KANTEL_ISOLATE_CPU_MS", default_value_t = 120_000)]
    pub cpu_ms: u64,
    /// Sandboxes with an isolate at once; past it the least recently used idle one gives its isolate up.
    #[arg(long, env = "KANTEL_ISOLATE_MAX_SANDBOXES", default_value_t = 64)]
    pub max_sandboxes: usize,
    /// node and python runs at once (default: twice the CPUs, 2 to 16).
    #[arg(long, env = "KANTEL_ISOLATE_MAX_RUNS")]
    pub max_runs: Option<usize>,
    #[arg(long, env = "KANTEL_ISOLATE_LOG_FORMAT", value_enum, default_value = "json")]
    pub log_format: LogFormat,
    /// A sandbox idle this long gives its isolate up (its next command gets a fresh one).
    #[arg(long, env = "KANTEL_ISOLATE_IDLE_MS", default_value_t = 15 * 60_000)]
    pub idle_ms: u64,
    /// Exit if the process can't apply its own Landlock policy fully (the systemd unit passes this).
    #[arg(long, env = "KANTEL_ISOLATE_REQUIRE_LANDLOCK", default_value_t = false)]
    pub require_landlock: bool,
    /// Allow running as root / with capabilities (tests and local experiments only).
    #[arg(long, env = "KANTEL_ISOLATE_ALLOW_ROOT", default_value_t = false)]
    pub allow_root: bool,
}

pub const DEFAULT_MEMORY_MIB: usize = 256;
pub const MIN_MEMORY_MIB: usize = 128;
pub const MAX_MEMORY_MIB: usize = 512;
/// A command's wall clock when the request gives none (kantel-host's default).
pub const DEFAULT_WALL: Duration = Duration::from_secs(30);
/// The longest wall clock a request may ask for (kantel-host's maximum).
pub const MAX_WALL: Duration = Duration::from_secs(600);

/// The resolved configuration, shared by every thread.
#[derive(Debug, Clone)]
pub struct Config {
    /// Listen address: `host:port` or `unix:/path`.
    pub listen: String,
    pub store: Target,
    pub egress: Target,
    #[allow(dead_code)]
    pub assets: PathBuf,
    pub pyodide: PathBuf,
    pub python_snapshot: PathBuf,
    pub pool: usize,
    pub node_pool: usize,
    pub python_pool: usize,
    pub cpu: Duration,
    pub max_sandboxes: usize,
    pub max_runs: usize,
    pub log_format: LogFormat,
    pub idle: Duration,
}

impl Config {
    pub fn from_args(a: &ServeArgs) -> Result<Config> {
        let assets = std::fs::canonicalize(&a.assets).with_context(|| format!("--assets {}", a.assets.display()))?;
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        Ok(Config {
            listen: a.listen.clone(),
            store: Target::parse(&a.store)?,
            egress: Target::parse(&a.egress)?,
            pyodide: assets.join("pyodide"),
            python_snapshot: assets.join("python.snapshot"),
            assets,
            pool: a.pool.min(64),
            node_pool: a.node_pool.min(16),
            python_pool: a.python_pool.min(8),
            cpu: Duration::from_millis(a.cpu_ms.max(1)),
            max_sandboxes: a.max_sandboxes.max(1),
            max_runs: a.max_runs.unwrap_or((cpus * 2).clamp(2, 16)).max(1),
            log_format: a.log_format,
            idle: Duration::from_millis(a.idle_ms.max(1000)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_read_the_environment() {
        // SAFETY: tests in this module don't read the variable concurrently.
        unsafe { std::env::set_var("KANTEL_ISOLATE_MAX_SANDBOXES", "7") };
        let cli = Cli::try_parse_from(["kantel-isolate", "serve", "--assets", "/tmp"]).unwrap();
        let Cmd::Serve(a) = cli.command else { panic!("serve") };
        assert_eq!(a.max_sandboxes, 7);
        assert_eq!(a.cpu_ms, 120_000);
        unsafe { std::env::remove_var("KANTEL_ISOLATE_MAX_SANDBOXES") };
    }
}
