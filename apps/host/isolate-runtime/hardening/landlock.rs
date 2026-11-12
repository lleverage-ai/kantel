//! Landlock: the file system and network `kantel-isolate` may use. Apply with [`restrict`] before the process
//! starts its first thread.
//!
//! Landlock's TCP rules (ABI 4, Linux 6.7) constrain the destination *port*, not the host, and don't touch UDP. So
//! allowing connect to ports 7001 and 7002 allows those ports on *any* reachable host, and leaves UDP open. In the
//! isolate VM that is harmless (no network device; nothing to reach). In native mode it is not egress confinement:
//! the real fence there is the Unix-socket transport in a 0700 per-account directory plus an empty network namespace
//! (see SECURITY.md finding 5). When the runtime talks over Unix sockets ([`Transport::Unix`]), [`restrict`] forbids
//! TCP entirely and allows only AF_UNIX, and the port rules disappear.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, NetPort, PathBeneath, PathFd,
    Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, Scope, path_beneath_rules,
};

/// How the runtime reaches its store and egress bridges, and serves its own API.
pub enum Transport {
    /// TCP on 127.0.0.1. `listen` is the port `--listen` binds; `connect` are the store's and egress's ports. The
    /// rules bound the ports but not the host (see the module docs): a second fence (a network namespace) is still
    /// needed in native mode.
    Tcp { listen: u16, connect: Vec<u16> },
    /// Unix sockets in `socket_dir` (0700, the account's own). No TCP is allowed at all; the directory is read-write
    /// so the runtime can bind its listener there, and the bridges' sockets are read-write too.
    Unix { socket_dir: PathBuf },
}

/// What the process may touch once restricted.
pub struct Policy {
    /// `--assets`: read only (the guest bundles, Pyodide and its snapshot).
    pub assets: PathBuf,
    /// The process's own temporary directory: read and write. kantel-isolate creates it (0700) before calling
    /// [`restrict`]; nothing else is writable.
    pub temp: PathBuf,
    /// More read-only paths, if any (a Pyodide snapshot kept outside `--assets`, in the spike).
    pub extra_read: Vec<PathBuf>,
    /// How it talks to the store and egress, and serves its API.
    pub transport: Transport,
}

/// System files the process reads after start-up, all read only: V8 opens /dev/urandom for each isolate's random
/// number generator, reads /proc/self/maps for the main thread's stack and the CPU topology; jemalloc reads the
/// transparent huge page and overcommit settings; Rust's available_parallelism reads the cgroup's CPU quota; ICU and
/// chrono read the time zone. Paths that don't exist on this system are skipped.
const SYSTEM_READ: &[&str] = &[
    "/dev/urandom",
    "/dev/null",
    "/proc/self",
    "/proc/sys/vm/overcommit_memory",
    "/sys/devices/system/cpu",
    "/sys/fs/cgroup",
    "/sys/kernel/mm/transparent_hugepage",
    "/etc/localtime",
    "/usr/share/zoneinfo",
];

/// What [`restrict`] managed to enforce on this kernel.
#[derive(Debug)]
pub struct Report {
    /// Fully, partially (an older ABI: e.g. Linux 6.1's has no TCP rules) or not at all (no Landlock).
    pub status: &'static str,
    /// The kernel's Landlock ABI version (0 without Landlock).
    pub abi: i32,
    /// Whether the TCP port rules are in force (Landlock ABI 4, Linux 6.7). NOTE: with [`Transport::Tcp`] this
    /// bounds the destination *ports*, not the host, and doesn't cover UDP; it is not egress confinement. With
    /// [`Transport::Unix`] it means TCP is forbidden outright, which is confinement.
    pub network: bool,
}

/// Restricts this thread and every thread it starts from now on. Best effort across kernels: on one without
/// Landlock or with an older ABI it enforces what the kernel has and says so in the [`Report`] (the caller logs it;
/// in production `--require-landlock` makes less than full enforcement fatal).
pub fn restrict(policy: &Policy) -> Result<Report> {
    let abi = ABI::V6;
    let read = AccessFs::from_read(abi);
    let all = AccessFs::from_all(abi);
    let net_supported = ABI::V4;
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(all)?
        .handle_access(AccessNet::BindTcp | AccessNet::ConnectTcp)?
        .scope(Scope::AbstractUnixSocket | Scope::Signal)?
        .create()?
        .add_rules(path_beneath_rules([&policy.assets], read))?
        .add_rules(path_beneath_rules(&policy.extra_read, read))?
        .add_rules(path_beneath_rules(
            SYSTEM_READ.iter().map(Path::new).filter(|p| p.exists()),
            read,
        ))?;
    // A directory gets every right below it; PathFd needs the directory to exist (the caller made it).
    let temp = PathFd::new(&policy.temp)
        .with_context(|| format!("landlock: temp dir {}", policy.temp.display()))?;
    ruleset = ruleset.add_rule(PathBeneath::new(temp, all))?;
    match &policy.transport {
        Transport::Tcp { listen, connect } => {
            // handle_access(Bind|Connect) above with no matching NetPort rule denies every other port.
            ruleset = ruleset.add_rule(NetPort::new(*listen, AccessNet::BindTcp))?;
            for port in connect {
                ruleset = ruleset.add_rule(NetPort::new(*port, AccessNet::ConnectTcp))?;
            }
        }
        Transport::Unix { socket_dir } => {
            // No NetPort rule at all: handle_access(Bind|Connect) with none denies all TCP. The socket directory is
            // the account's own; the runtime binds its listener and the bridges' sockets live there.
            let dir = PathFd::new(socket_dir)
                .with_context(|| format!("landlock: socket dir {}", socket_dir.display()))?;
            ruleset = ruleset.add_rule(PathBeneath::new(dir, all))?;
        }
    }
    let status = ruleset.restrict_self().context("landlock: restrict_self")?;
    let abi = kernel_abi();
    let network = status.ruleset != RulesetStatus::NotEnforced && abi >= net_supported as i32;
    Ok(Report {
        status: match status.ruleset {
            RulesetStatus::FullyEnforced => "fully enforced",
            RulesetStatus::PartiallyEnforced => "partially enforced (older Landlock ABI)",
            RulesetStatus::NotEnforced => "not enforced (no Landlock in this kernel)",
        },
        abi,
        network,
    })
}

/// The kernel's Landlock ABI version (0 without Landlock).
pub fn kernel_abi() -> i32 {
    // SAFETY: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) only returns the version.
    let v = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0usize,
            1u32,
        )
    };
    if v < 0 { 0 } else { v as i32 }
}
