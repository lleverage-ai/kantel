//! Applies the process hardening in `hardening/` to a runtime with a given configuration: what `kantel-isolate serve`
//! does to itself before its first thread starts.

use std::path::PathBuf;

use anyhow::{Result, bail};

use crate::bridges::Target;
use crate::config::Config;
use crate::hardening;

/// What the process does to itself before its first thread starts (see `hardening/`). Kantel's is
/// [`HardeningPolicy::kantel`]; an embedder sets its own paths and whether it starts child processes.
#[derive(Clone, Debug)]
pub struct HardeningPolicy {
    /// Allow running as root or with capabilities (tests and local experiments only).
    pub allow_root: bool,
    /// Fail when Landlock enforces nothing on this kernel.
    pub require_landlock: bool,
    /// More paths the process may read, beside the assets, its temporary directory and the system files V8 reads.
    pub read: Vec<PathBuf>,
    /// Paths it may read and write, beside its temporary directory.
    pub read_write: Vec<PathBuf>,
    /// Programs, or directories of them, it may execute. Only with `spawn`.
    pub execute: Vec<PathBuf>,
    /// The seccomp filter's mode, or None for no filter.
    pub seccomp: Option<hardening::seccomp::Mode>,
    /// Let the process start child processes (fork, exec, wait), never with namespaces of their own. A child
    /// inherits the filter and Landlock: it runs only what `execute` names, under the same allow-list.
    pub spawn: bool,
}

impl HardeningPolicy {
    /// Kantel's runtime: no extra paths, no child processes, the filter in `seccomp` (`enforce`, `log` or `off`).
    pub fn kantel(
        require_landlock: bool,
        allow_root: bool,
        seccomp: &str,
    ) -> Result<HardeningPolicy> {
        Ok(HardeningPolicy {
            allow_root,
            require_landlock,
            read: vec![],
            read_write: vec![],
            execute: vec![],
            seccomp: match seccomp {
                "off" => None,
                mode => Some(mode.parse()?),
            },
            spawn: false,
        })
    }
}

/// Process hardening (W2's module): no root/capabilities, non-dumpable, then a Landlock policy that allows only
/// `--assets` (read), a private temp dir (read-write), the few system files V8/jemalloc read, the policy's own paths,
/// and either the Unix socket directory (no TCP at all) or the store/egress/listen TCP ports; then seccomp.
pub fn harden(cfg: &Config, hardening: &HardeningPolicy) -> Result<()> {
    let require_landlock = hardening.require_landlock;
    if !hardening.spawn && !hardening.execute.is_empty() {
        bail!(
            "a hardening policy names programs to execute but doesn't allow child processes (spawn)"
        );
    }
    crate::hardening::check_privileges(hardening.allow_root)?;
    let temp = std::env::temp_dir().join(format!("kantel-isolate-{}", std::process::id()));
    std::fs::create_dir_all(&temp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700));
    }
    let transport = transport_of(cfg);
    // Landlock's rights add up down the tree: an executable path above a writable one would make what is written
    // there executable.
    let socket_dir = match &transport {
        crate::hardening::landlock::Transport::Unix { socket_dir } => Some(socket_dir.clone()),
        crate::hardening::landlock::Transport::Tcp { .. } => None,
    };
    let writable: Vec<PathBuf> = hardening
        .read_write
        .iter()
        .chain([&temp])
        .chain(socket_dir.iter())
        .map(resolved)
        .collect::<Result<_>>()?;
    let execute: Vec<PathBuf> = hardening
        .execute
        .iter()
        .map(resolved)
        .collect::<Result<_>>()?;
    check_execute(&execute, &writable)?;
    let policy = crate::hardening::landlock::Policy {
        assets: cfg.assets.clone(),
        temp,
        extra_read: hardening.read.clone(),
        read_write: hardening
            .read_write
            .iter()
            .map(resolved)
            .collect::<Result<_>>()?,
        execute,
        transport,
    };
    let report = crate::hardening::landlock::restrict(&policy)?;
    tracing::info!(
        status = report.status,
        abi = report.abi,
        network = report.network,
        "landlock"
    );
    // --require-landlock fails closed when Landlock enforces nothing. An older ABI (the isolate VM's Linux 6.1 has
    // ABI 2) still enforces the file-system rules but not the TCP-port ones: that's accepted with a warning, because
    // the network is fenced elsewhere — the VM has no network device, and with Unix-socket transport (native mode)
    // the seccomp filter below allows no TCP or UDP socket at all, on any kernel.
    if report.status.starts_with("not enforced") {
        if require_landlock {
            anyhow::bail!(
                "--require-landlock: Landlock is {} on this kernel",
                report.status
            );
        }
        tracing::warn!(
            status = report.status,
            "landlock: the runtime runs without its file-system rules"
        );
    } else if report.status != "fully enforced" {
        tracing::warn!(
            status = report.status,
            abi = report.abi,
            "landlock: file-system rules only; the network is fenced by seccomp and the VM"
        );
    }
    // Last, still before any thread: every thread V8, tokio and the pools start inherits the filter.
    match hardening.seccomp {
        None => tracing::warn!("seccomp: off: the runtime runs without its syscall filter"),
        Some(mode) => {
            let sockets = match transport_of(cfg) {
                crate::hardening::landlock::Transport::Unix { .. } => {
                    crate::hardening::seccomp::Sockets::UnixOnly
                }
                crate::hardening::landlock::Transport::Tcp { .. } => {
                    crate::hardening::seccomp::Sockets::UnixAndIpv4
                }
            };
            let report = crate::hardening::seccomp::install(mode, sockets, hardening.spawn)?;
            tracing::info!(%report, spawn = hardening.spawn, "seccomp");
        }
    }
    Ok(())
}

/// A policy path as Landlock will see it: absolute, with symlinks and `..` resolved.
fn resolved(path: &PathBuf) -> Result<PathBuf> {
    std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("hardening policy path {}: {e}", path.display()))
}

/// No executable path may overlap a writable one (inside it, or containing it): Landlock's rights add up down the
/// tree, so either way something writable would be executable. Paths are resolved ([`resolved`]).
fn check_execute(execute: &[PathBuf], writable: &[PathBuf]) -> Result<()> {
    for exec in execute {
        for place in writable {
            if place.starts_with(exec) || exec.starts_with(place) {
                bail!(
                    "the hardening policy's executable path {} overlaps the writable {}",
                    exec.display(),
                    place.display()
                );
            }
        }
    }
    Ok(())
}

/// The Landlock transport: Unix (no TCP) when `--listen`, `--store` and `--egress` are all Unix sockets, else TCP
/// with the ports the runtime binds and connects to.
pub fn transport_of(cfg: &Config) -> hardening::landlock::Transport {
    let listen_unix = cfg.listen.strip_prefix("unix:");
    if let (Some(listen), Target::Unix(store), Target::Unix(egress)) =
        (listen_unix, &cfg.store, &cfg.egress)
    {
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
    let listen = cfg
        .listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(0);
    let connect = [port(&cfg.store), port(&cfg.egress)]
        .into_iter()
        .flatten()
        .collect();
    hardening::landlock::Transport::Tcp { listen, connect }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_executable_path_may_not_overlap_a_writable_one() {
        let root = std::env::temp_dir().join(format!("kt-harden-{}", std::process::id()));
        let (tools, scratch, bin) = (
            root.join("tools"),
            root.join("scratch"),
            root.join("scratch/bin"),
        );
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        // An alias: a writable path that is a symlink into an executable one.
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&tools, &alias).unwrap();
        let r = |p: &PathBuf| resolved(p).unwrap();
        // Executable inside writable, writable inside executable, the same path, and through the alias.
        assert!(check_execute(&[r(&bin)], &[r(&scratch)]).is_err());
        assert!(check_execute(&[r(&root)], &[r(&scratch)]).is_err());
        assert!(check_execute(&[r(&scratch)], &[r(&scratch)]).is_err());
        assert!(check_execute(&[r(&tools)], &[r(&alias)]).is_err());
        // Apart, they're fine.
        assert!(check_execute(&[r(&tools)], &[r(&scratch)]).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
