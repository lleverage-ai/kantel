//! Process hardening for `kantel-isolate`: what the process does to itself so that a bug in V8 or in the runtime
//! that gives guest code native execution still can't reach another account, the host, or much of anything.
//!
//! Two layers, in the order `main` applies them:
//!
//! 1. [`check_privileges`], first thing: refuses to run as root or with any capability, and marks the process
//!    non-dumpable (no ptrace attach or `/proc/<pid>/mem` from other processes of the same user, no core dumps of
//!    guest memory).
//! 2. [`landlock::restrict`], before the first thread starts (Landlock binds the calling thread and the threads it
//!    starts afterwards; kernels before 7.0 can't apply it to threads that already exist): read-only `--assets`,
//!    read-write only its own temporary directory, the few system files V8 and the allocator read. With Unix-socket
//!    transport it forbids TCP entirely and allows only the socket directory; with TCP transport, and Landlock ABI 4
//!    (Linux 6.7), it bounds the bind and connect *ports* — not the host, and not UDP, so that is not egress
//!    confinement (see `landlock.rs` and SECURITY.md). Signals and abstract Unix sockets are scoped to the process
//!    with ABI 6 (Linux 6.12).
//!
//! 3. [`seccomp::install`], after Landlock and before the first thread: a kill list for the calls that matter most to
//!    an attacker (exec, ptrace, mounts and namespaces, bpf, io_uring, …), and an allow-list with argument checks
//!    for everything else (threads only, IPv4 and Unix sockets only, a few ioctls and prctls). See `seccomp.rs`.
//!
//! The systemd unit (`../systemd/kantel-isolate.service`) repeats the policy as a second, independent layer in the
//! isolate VM; in native mode kantel-host's `startNative` has to provide the user, cgroup and namespaces (see
//! `../SECURITY.md`).
//!
//! Include it from the crate's main.rs with `mod hardening;` (this directory as `src/hardening/`, or
//! `#[path = "../hardening/mod.rs"] mod hardening;`). Dependencies: `landlock = "0.4"`,
//! `libc = "0.2"`, `anyhow = "1"`, `seccompiler = "0.5"`.

pub mod landlock;
pub mod seccomp;

use anyhow::{bail, Result};

// capget(2)'s structures (linux/capability.h; the libc crate doesn't have them).
const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

/// Refuses to run with privileges, and makes the process non-dumpable. Call first in `main`.
///
/// `allow_root` is for tests and local experiments only (`--allow-root`); in the isolate VM and in native mode the
/// runtime must have its own unprivileged user.
pub fn check_privileges(allow_root: bool) -> Result<()> {
    // SAFETY: plain syscalls with no pointers, or with pointers to locals.
    unsafe {
        if !allow_root {
            // Real, effective and saved IDs: a launcher that drops only the effective uid leaves the saved one 0,
            // and the process could setuid(0) back.
            let (mut r, mut e, mut s) = (0, 0, 0);
            if libc::getresuid(&mut r, &mut e, &mut s) != 0 {
                bail!("getresuid: {}", std::io::Error::last_os_error());
            }
            if r == 0 || e == 0 || s == 0 {
                bail!("kantel-isolate must not run as root (uids real {r}, effective {e}, saved {s}): run it as its own unprivileged user");
            }
            let (mut r, mut e, mut s) = (0, 0, 0);
            if libc::getresgid(&mut r, &mut e, &mut s) != 0 {
                bail!("getresgid: {}", std::io::Error::last_os_error());
            }
            if r == 0 || e == 0 || s == 0 {
                bail!("kantel-isolate must not run with group root (gids real {r}, effective {e}, saved {s})");
            }
            // Supplementary groups: none may be root's (gid 0). Other groups are the launcher's policy; the unit
            // and native mode give it none.
            let n = libc::getgroups(0, std::ptr::null_mut());
            if n < 0 {
                bail!("getgroups: {}", std::io::Error::last_os_error());
            }
            let mut groups = vec![0 as libc::gid_t; n as usize];
            let n = libc::getgroups(n, groups.as_mut_ptr());
            if n < 0 {
                bail!("getgroups: {}", std::io::Error::last_os_error());
            }
            if groups[..n as usize].contains(&0) {
                bail!("kantel-isolate must not be in group root (supplementary groups {:?})", &groups[..n as usize]);
            }
        }
        let mut header = CapHeader { version: LINUX_CAPABILITY_VERSION_3, pid: 0 };
        let mut data = [CapData::default(); 2];
        if libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) != 0 {
            bail!("capget: {}", std::io::Error::last_os_error());
        }
        // Effective and permitted only: an inheritable set without permitted grants nothing (and no_new_privs below stops
        // file capabilities from adding to it).
        let any = data.iter().any(|d| d.effective != 0 || d.permitted != 0);
        if any && !allow_root {
            bail!("kantel-isolate must run with no capabilities (CapabilityBoundingSet= in its unit, or none in native mode)");
        }
        // Ambient capabilities would come back on an exec: clear them.
        libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0);
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            bail!("PR_SET_NO_NEW_PRIVS: {}", std::io::Error::last_os_error());
        }
        if libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 {
            bail!("PR_SET_DUMPABLE: {}", std::io::Error::last_os_error());
        }
    }
    Ok(())
}
