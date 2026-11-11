//! Landlock: the file system and TCP ports `kantel-isolate` may use. Apply with [`restrict`] before the process
//! starts its first thread.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use landlock::{
    path_beneath_rules, Access, AccessFs, AccessNet, CompatLevel, Compatible, NetPort, PathBeneath, PathFd, Ruleset,
    RulesetAttr, RulesetCreatedAttr, RulesetStatus, Scope, ABI,
};

/// What the process may touch once restricted.
pub struct Policy {
    /// `--assets`: read only (the guest bundles, Pyodide and its snapshot).
    pub assets: PathBuf,
    /// The process's own temporary directory: read and write. kantel-isolate creates it (0700) before calling
    /// [`restrict`]; nothing else is writable.
    pub temp: PathBuf,
    /// More read-only paths, if any (a Pyodide snapshot kept outside `--assets`, in the spike).
    pub extra_read: Vec<PathBuf>,
    /// The port `--listen` binds.
    pub listen_port: u16,
    /// The ports of `--store` and `--egress` (on 127.0.0.1): the only TCP connections the process may make.
    pub connect_ports: Vec<u16>,
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
    /// Whether TCP connect/bind are restricted to the ports in the policy (Landlock ABI 4, Linux 6.7).
    pub network: bool,
}

/// Restricts this thread and every thread it starts from now on. Best effort across kernels: on one without
/// Landlock or with an older ABI it enforces what the kernel has and says so in the [`Report`] (the caller logs it;
/// in production `--require-landlock` makes "not enforced" fatal).
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
        .add_rules(path_beneath_rules(SYSTEM_READ.iter().map(Path::new).filter(|p| p.exists()), read))?;
    // A directory gets every right below it; PathFd needs the directory to exist (the caller made it).
    let temp = PathFd::new(&policy.temp).with_context(|| format!("landlock: temp dir {}", policy.temp.display()))?;
    ruleset = ruleset.add_rule(PathBeneath::new(temp, all))?;
    ruleset = ruleset.add_rule(NetPort::new(policy.listen_port, AccessNet::BindTcp))?;
    for port in &policy.connect_ports {
        ruleset = ruleset.add_rule(NetPort::new(*port, AccessNet::ConnectTcp))?;
    }
    let status = ruleset.restrict_self().context("landlock: restrict_self")?;
    let network = status.ruleset != RulesetStatus::NotEnforced && kernel_abi() >= net_supported as i32;
    Ok(Report {
        status: match status.ruleset {
            RulesetStatus::FullyEnforced => "fully enforced",
            RulesetStatus::PartiallyEnforced => "partially enforced (older Landlock ABI)",
            RulesetStatus::NotEnforced => "not enforced (no Landlock in this kernel)",
        },
        network,
    })
}

/// The kernel's Landlock ABI version (0 without Landlock).
pub fn kernel_abi() -> i32 {
    // SAFETY: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) only returns the version.
    let v = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0usize, 1u32) };
    if v < 0 { 0 } else { v as i32 }
}
