//! The runtime's settings, shared by every thread. The `kantel-isolate` binary makes them from its command line
//! (`src/cli.rs`); an embedder makes them with [`Config::new`] and sets what it needs.

use std::path::PathBuf;
use std::time::Duration;

use crate::bridges::Target;

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
    pub assets: PathBuf,
    pub pyodide: PathBuf,
    pub python_snapshot: PathBuf,
    pub pool: usize,
    pub node_pool: usize,
    pub python_pool: usize,
    pub cpu: Duration,
    pub max_sandboxes: usize,
    pub max_runs: usize,
    pub idle: Duration,
    /// How long a stopped command's reply waits for a commit the command started. A commit still running after it
    /// holds the sandbox's next command back (refused, retryable) until it ends, so it can't overwrite later work.
    pub commit_grace: Duration,
}

impl Config {
    /// The defaults `kantel-isolate serve` has, with the assets directory `assets` (made by build-assets.sh: the
    /// Pyodide distribution and its memory snapshot). The store and egress bridges are on loopback ports 7001 and 7002.
    /// `assets` is resolved to its canonical absolute path when it exists, as `--assets` is: Pyodide's modules are
    /// loaded by `file://` URL from it, and a read is allowed only inside its canonical path.
    pub fn new(assets: PathBuf) -> Config {
        let assets = std::fs::canonicalize(&assets).unwrap_or(assets);
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        Config {
            listen: "127.0.0.1:8080".into(),
            store: Target::Tcp("127.0.0.1:7001".into()),
            egress: Target::Tcp("127.0.0.1:7002".into()),
            pyodide: assets.join("pyodide"),
            python_snapshot: assets.join("python.snapshot"),
            assets,
            pool: 2,
            node_pool: 2,
            python_pool: 1,
            cpu: Duration::from_secs(120),
            max_sandboxes: 64,
            max_runs: (cpus * 2).clamp(2, 16),
            idle: Duration::from_secs(15 * 60),
            commit_grace: Duration::from_secs(15),
        }
    }
}
