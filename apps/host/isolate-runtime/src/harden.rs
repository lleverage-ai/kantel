//! Applies the process hardening in `hardening/` to a runtime with a given configuration: what `kantel-isolate serve`
//! does to itself before its first thread starts.

use anyhow::Result;

use crate::bridges::Target;
use crate::config::Config;
use crate::hardening;

/// Process hardening (W2's module): no root/capabilities, non-dumpable, then a Landlock policy that allows only
/// `--assets` (read), a private temp dir (read-write), the few system files V8/jemalloc read, and either the Unix
/// socket directory (no TCP at all) or the store/egress/listen TCP ports.
pub fn harden(cfg: &Config, require_landlock: bool, allow_root: bool, seccomp: &str) -> Result<()> {
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
