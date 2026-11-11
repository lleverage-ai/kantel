//! Process hardening for `kantel-isolate`: what the process does to itself so that a bug in V8 or in the runtime
//! that gives guest code native execution still can't reach another account, the host, or much of anything.
//!
//! Three layers, in the order `main` applies them:
//!
//! 1. [`check_privileges`], first thing: refuses to run as root or with any capability, and marks the process
//!    non-dumpable (no ptrace attach or `/proc/<pid>/mem` from other processes of the same user, no core dumps of
//!    guest memory).
//! 2. [`landlock::restrict`], before the first thread starts (Landlock binds the calling thread and the threads it
//!    starts afterwards; kernels before 7.0 can't apply it to threads that already exist): read-only `--assets`,
//!    read-write only its own temporary directory, the few system files V8 and the allocator read, and with
//!    Landlock ABI 4 (Linux 6.7) TCP connect only to the store's and egress bridge's ports and bind only to its own.
//!    Signals and abstract Unix sockets are scoped to the process with ABI 6 (Linux 6.12).
//! 3. [`seccomp::apply`], once initialisation is done (V8's platform is up, the snapshots are built, the listener is
//!    bound): a syscall allow-list on every thread (TSYNC). No exec, no new processes, no sockets but TCP over IPv4,
//!    no ptrace, mount, namespaces, BPF, io_uring, keyrings, perf or module loading.
//!
//! The systemd unit (`../systemd/kantel-isolate.service`) repeats the policy as a second, independent layer in the
//! isolate VM; in native mode kantel-host's `startNative` has to provide the user, cgroup and namespaces (see
//! `../SECURITY.md`).
//!
//! Include it from the crate's main.rs with `mod hardening;` (this directory as `src/hardening/`, or
//! `#[path = "../hardening/mod.rs"] mod hardening;`). Dependencies: `seccompiler = "0.5"`, `landlock = "0.4"`,
//! `libc = "0.2"`, `anyhow = "1"`.

pub mod landlock;

use anyhow::{bail, Result};

/// Refuses to run with privileges, and makes the process non-dumpable. Call first in `main`.
///
/// `allow_root` is for tests and local experiments only (`--allow-root`); in the isolate VM and in native mode the
/// runtime must have its own unprivileged user.
pub fn check_privileges(allow_root: bool) -> Result<()> {
    // SAFETY: plain syscalls with no pointers, or with pointers to locals.
    unsafe {
        if !allow_root && (libc::geteuid() == 0 || libc::getuid() == 0) {
            bail!("kantel-isolate must not run as root: run it as its own unprivileged user");
        }
        let mut header = libc::__user_cap_header_struct { version: libc::_LINUX_CAPABILITY_VERSION_3, pid: 0 };
        let mut data = [libc::__user_cap_data_struct { effective: 0, permitted: 0, inheritable: 0 }; 2];
        if libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) != 0 {
            bail!("capget: {}", std::io::Error::last_os_error());
        }
        let any = data.iter().any(|d| d.effective != 0 || d.permitted != 0 || d.inheritable != 0);
        if any && !allow_root {
            bail!("kantel-isolate must run with no capabilities (CapabilityBoundingSet= in its unit, or none in native mode)");
        }
        // Ambient capabilities would come back on an exec; seccomp forbids exec, but clear them anyway.
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
