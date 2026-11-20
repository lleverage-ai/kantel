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

/// What guest code may send out, and how (its `fetch`, the shell's `curl` and `wget`, Python's `pyfetch`). Every
/// request goes to the egress proxy at [`Config::egress`], in proxy style, tagged with the sandbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressPolicy {
    /// Whether guest code may make requests at all. Off, every request fails ("no network access").
    pub enabled: bool,
    /// The header that carries the sandbox id to the proxy, which attributes and authorises the request by it. A
    /// guest's own header of that name is dropped, as are its `kantel-*` headers.
    pub sandbox_header: String,
    /// The HTTP methods guest code may use (upper case). Never CONNECT.
    pub methods: Vec<String>,
    /// The most of one response body, in bytes (the isolate's memory bounds it too).
    pub max_body: usize,
    /// Requests one isolate may have in flight.
    pub max_concurrent: usize,
}

impl Default for EgressPolicy {
    /// Kantel's: on, tagged `kantel-isolate-sandbox`, the methods a browser's fetch uses, 64 MiB bodies, 8 at once.
    fn default() -> Self {
        EgressPolicy {
            enabled: true,
            sandbox_header: "kantel-isolate-sandbox".into(),
            methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
                .map(String::from)
                .to_vec(),
            max_body: 64 * 1024 * 1024,
            max_concurrent: 8,
        }
    }
}

/// The resolved configuration, shared by every thread.
#[derive(Debug, Clone)]
pub struct Config {
    /// Listen address: `host:port` or `unix:/path`.
    pub listen: String,
    pub store: Target,
    /// The egress proxy's bridge.
    pub egress: Target,
    /// What may go through it.
    pub egress_policy: EgressPolicy,
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
            egress_policy: EgressPolicy::default(),
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
        }
    }
}
