//! A seccomp-bpf filter that `kantel-isolate` installs on itself, the third layer after [`super::check_privileges`]
//! and [`super::landlock::restrict`]. It limits the kernel surface a bug in V8 or in the runtime could reach once
//! guest code has native execution.
//!
//! Install it in `main` after Landlock and before the first thread starts: every thread made afterwards inherits
//! it, and the filters are synchronised to any thread that already exists (`TSYNC`). Three filters are stacked, and
//! the kernel takes the most restrictive answer:
//!
//! 1. **Kill**: calls the runtime never makes and that matter most to an attacker (exec, ptrace, mounts and
//!    namespaces, bpf, io_uring, keyrings, module loading, identity changes, …) kill the whole process at once.
//! 2. **No `clone3`**: answers `ENOSYS`, so glibc falls back to `clone(2)`, whose flags (unlike `clone3`'s, which
//!    are behind a pointer) the allow-list can check.
//! 3. **Allow-list**: what the runtime was seen to use across its benchmark (shell, node and python commands,
//!    pools, the store and egress bridges), with arguments checked where they matter: `clone` only with
//!    `CLONE_THREAD` (threads, never processes), `socket` only `AF_UNIX` and `AF_INET`, `ioctl` only `TCGETS`,
//!    `FIONBIO` and `FIOCLEX`, `prctl` only thread and mapping names. Anything else fails with `EPERM` (or, in
//!    [`Mode::Log`], is allowed and logged by the kernel, for finding a call a new code path needs).
//!
//! The allow-list was derived from `strace -f` over the benchmark in the isolate VM's Debian base, plus the calls
//! that trace left out on purpose (memory, futexes, epoll waits, reads and writes, clocks, signals). If a release
//! starts failing with `EPERM` somewhere new, run it with `--seccomp log` and read the audit log (`SECCOMP` records
//! with `syscall=`), then add the call here with a comment saying what needs it.
//!
//! Dependencies: `seccompiler = "0.5"`, `libc = "0.2"`, `anyhow = "1"`.

use std::collections::BTreeMap;
use std::convert::TryInto;

use anyhow::{anyhow, bail, Result};
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
    TargetArch,
};

/// How the allow-list treats a call that isn't on it. The kill list and the `clone3` rule apply in both modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Refuse it with `EPERM`: the production setting.
    Enforce,
    /// Allow it and have the kernel log it (`SECCOMP_RET_LOG`): for finding what a new code path needs.
    Log,
}

impl std::str::FromStr for Mode {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "enforce" => Ok(Mode::Enforce),
            "log" => Ok(Mode::Log),
            other => bail!("--seccomp must be enforce, log or off, not {other:?}"),
        }
    }
}

/// What [`install`] did, for the start-up log line.
#[derive(Debug)]
pub struct Report {
    pub mode: Mode,
    pub sockets: Sockets,
    pub allowed: usize,
    pub killed: usize,
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mode = match self.mode {
            Mode::Enforce => "enforced",
            Mode::Log => "logging only",
        };
        let sockets = match self.sockets {
            Sockets::UnixOnly => "Unix sockets only",
            Sockets::UnixAndIpv4 => "Unix and IPv4 sockets",
        };
        write!(f, "{mode}: {} calls allowed, {} kill the process, {sockets}", self.allowed, self.killed)
    }
}

fn arch() -> Result<TargetArch> {
    std::env::consts::ARCH.try_into().map_err(|e| anyhow!("seccomp: unsupported architecture: {e:?}"))
}

/// The calls that kill the process. None of them is made by the runtime after start-up.
fn kill_list() -> Vec<i64> {
    let mut calls = vec![
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_userfaultfd,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_personality,
        libc::SYS_setuid,
        libc::SYS_setgid,
        libc::SYS_setreuid,
        libc::SYS_setregid,
        libc::SYS_setresuid,
        libc::SYS_setresgid,
        libc::SYS_setgroups,
        libc::SYS_setfsuid,
        libc::SYS_setfsgid,
        libc::SYS_mknodat,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_reboot,
        libc::SYS_acct,
        libc::SYS_quotactl,
        libc::SYS_kcmp,
        libc::SYS_pidfd_getfd,
        libc::SYS_vmsplice,
        libc::SYS_fanotify_init,
        libc::SYS_move_mount,
        libc::SYS_open_tree,
        libc::SYS_fsopen,
        libc::SYS_fsmount,
        libc::SYS_fsconfig,
        libc::SYS_fspick,
        libc::SYS_mount_setattr,
    ];
    #[cfg(target_arch = "x86_64")]
    calls.extend([
        libc::SYS_fork,
        libc::SYS_vfork,
        libc::SYS_mknod,
        libc::SYS_iopl,
        libc::SYS_ioperm,
        libc::SYS_uselib,
        libc::SYS_modify_ldt,
    ]);
    calls
}

/// `arg == value` on one argument, compared as a 64-bit value.
fn eq(arg: u8, value: u64) -> Result<SeccompCondition> {
    Ok(SeccompCondition::new(arg, SeccompCmpArgLen::Qword, SeccompCmpOp::Eq, value)?)
}

/// `arg & mask == value`.
fn masked(arg: u8, mask: u64, value: u64) -> Result<SeccompCondition> {
    Ok(SeccompCondition::new(arg, SeccompCmpArgLen::Qword, SeccompCmpOp::MaskedEq(mask), value)?)
}

/// One rule per allowed value of argument `arg` (rules are ORed; conditions within a rule are ANDed).
fn one_of(arg: u8, values: &[u64]) -> Result<Vec<SeccompRule>> {
    values.iter().map(|&value| Ok(SeccompRule::new(vec![eq(arg, value)?])?)).collect()
}

/// Which sockets the process may make: with every endpoint on a Unix socket (native mode), none but `AF_UNIX`, so
/// no TCP or UDP at all on any kernel (Landlock can only forbid TCP from ABI 4, and never UDP).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sockets {
    UnixOnly,
    UnixAndIpv4,
}

/// The allow-list: every call the runtime makes, with an empty rule list for "any arguments".
fn allow_list(sockets: Sockets) -> Result<BTreeMap<i64, Vec<SeccompRule>>> {
    let any: Vec<i64> = vec![
        // Memory: V8's heap, its sandbox reservation and code space, the allocators.
        libc::SYS_mmap,
        libc::SYS_munmap,
        libc::SYS_mprotect,
        libc::SYS_mremap,
        libc::SYS_madvise,
        libc::SYS_brk,
        libc::SYS_membarrier,
        // Memory protection keys: V8 write-protects JIT code with them where the CPU has them.
        libc::SYS_pkey_alloc,
        libc::SYS_pkey_free,
        libc::SYS_pkey_mprotect,
        // Threads and their bookkeeping (thread creation itself is `clone`, below).
        libc::SYS_futex,
        libc::SYS_set_robust_list,
        libc::SYS_get_robust_list,
        libc::SYS_rseq,
        libc::SYS_set_tid_address,
        libc::SYS_gettid,
        libc::SYS_getpid,
        libc::SYS_getppid,
        libc::SYS_exit,
        libc::SYS_exit_group,
        libc::SYS_sched_yield,
        libc::SYS_sched_getaffinity,
        libc::SYS_sched_getscheduler,
        libc::SYS_sched_getparam,
        libc::SYS_sigaltstack,
        libc::SYS_restart_syscall,
        // clone3 is answered ENOSYS by its own filter; it has to pass this one for that answer to stand.
        libc::SYS_clone3,
        // Signals: Rust's and V8's handlers, and glibc's abort, which sends to its own thread.
        libc::SYS_rt_sigaction,
        libc::SYS_rt_sigprocmask,
        libc::SYS_rt_sigreturn,
        libc::SYS_tgkill,
        // Time: the CPU watchdog reads thread CPU clocks, which aren't in the vDSO.
        libc::SYS_clock_gettime,
        libc::SYS_clock_getres,
        libc::SYS_clock_nanosleep,
        libc::SYS_nanosleep,
        libc::SYS_gettimeofday,
        libc::SYS_getrandom,
        // Files: assets (read-only by Landlock), its temporary directory, standard streams.
        libc::SYS_read,
        libc::SYS_write,
        libc::SYS_readv,
        libc::SYS_writev,
        libc::SYS_pread64,
        libc::SYS_pwrite64,
        libc::SYS_lseek,
        libc::SYS_openat,
        libc::SYS_close,
        libc::SYS_close_range,
        libc::SYS_fstat,
        libc::SYS_newfstatat,
        libc::SYS_statx,
        libc::SYS_faccessat,
        libc::SYS_faccessat2,
        libc::SYS_readlinkat,
        libc::SYS_getdents64,
        libc::SYS_getcwd,
        libc::SYS_mkdirat,
        libc::SYS_unlinkat,
        libc::SYS_renameat2,
        libc::SYS_ftruncate,
        libc::SYS_fsync,
        libc::SYS_fdatasync,
        libc::SYS_fcntl,
        libc::SYS_dup,
        libc::SYS_dup3,
        libc::SYS_pipe2,
        libc::SYS_eventfd2,
        // The event loops (tokio, deno_core).
        libc::SYS_epoll_create1,
        libc::SYS_epoll_ctl,
        libc::SYS_epoll_pwait,
        libc::SYS_epoll_pwait2,
        libc::SYS_ppoll,
        // Sockets: the listener and the store and egress bridges (socket families are checked below).
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept4,
        libc::SYS_connect,
        libc::SYS_shutdown,
        libc::SYS_setsockopt,
        libc::SYS_getsockopt,
        libc::SYS_getsockname,
        libc::SYS_getpeername,
        libc::SYS_recvfrom,
        libc::SYS_sendto,
        libc::SYS_recvmsg,
        libc::SYS_sendmsg,
        // Limits and identity, read only (changing identity is on the kill list).
        libc::SYS_prlimit64,
        libc::SYS_getrlimit,
        libc::SYS_getrusage,
        libc::SYS_sysinfo,
        libc::SYS_uname,
        libc::SYS_getuid,
        libc::SYS_geteuid,
        libc::SYS_getgid,
        libc::SYS_getegid,
        libc::SYS_getresuid,
        libc::SYS_getresgid,
        libc::SYS_getgroups,
    ];
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = any.into_iter().map(|call| (call, vec![])).collect();
    #[cfg(target_arch = "x86_64")]
    for call in [
        libc::SYS_open,
        libc::SYS_stat,
        libc::SYS_lstat,
        libc::SYS_access,
        libc::SYS_readlink,
        libc::SYS_poll,
        libc::SYS_epoll_wait,
        libc::SYS_arch_prctl,
        libc::SYS_dup2,
        libc::SYS_pipe,
        libc::SYS_mkdir,
        libc::SYS_unlink,
        libc::SYS_rename,
        libc::SYS_time,
    ] {
        rules.insert(call, vec![]);
    }

    // clone: threads only. A thread needs CLONE_THREAD (with CLONE_VM and CLONE_SIGHAND, which the kernel requires
    // alongside it); anything without it would be a new process.
    let thread = (libc::CLONE_THREAD | libc::CLONE_VM | libc::CLONE_SIGHAND) as u64;
    rules.insert(libc::SYS_clone, vec![SeccompRule::new(vec![masked(0, thread, thread)?])?]);
    // socket and socketpair: Unix sockets, and IPv4 only when an endpoint is TCP (the bridges are 127.0.0.1 or Unix
    // sockets; IPv6 is off). The type argument may carry SOCK_CLOEXEC and SOCK_NONBLOCK, so only the family is checked.
    let families: &[u64] = match sockets {
        Sockets::UnixOnly => &[libc::AF_UNIX as u64],
        Sockets::UnixAndIpv4 => &[libc::AF_UNIX as u64, libc::AF_INET as u64],
    };
    rules.insert(libc::SYS_socket, one_of(0, families)?);
    rules.insert(libc::SYS_socketpair, one_of(0, &[libc::AF_UNIX as u64])?);
    // ioctl: is-this-a-terminal, non-blocking and close-on-exec. Nothing else.
    rules.insert(libc::SYS_ioctl, one_of(1, &[libc::TCGETS as u64, libc::FIONBIO as u64, libc::FIOCLEX as u64])?);
    // prctl: naming threads and anonymous mappings, and reading the dumpable flag and thread names.
    rules.insert(
        libc::SYS_prctl,
        one_of(
            0,
            &[libc::PR_SET_NAME as u64, libc::PR_GET_NAME as u64, libc::PR_SET_VMA as u64, libc::PR_GET_DUMPABLE as u64],
        )?,
    );
    Ok(rules)
}

fn compile(rules: BTreeMap<i64, Vec<SeccompRule>>, mismatch: SeccompAction, matched: SeccompAction) -> Result<BpfProgram> {
    let filter = SeccompFilter::new(rules, mismatch, matched, arch()?)?;
    Ok(filter.try_into()?)
}

/// Installs the three filters on the calling thread, in the order that makes the most restrictive one win. Call it
/// after Landlock and before any other thread starts. It can't be undone.
pub fn install(mode: Mode, sockets: Sockets) -> Result<Report> {
    let killed = kill_list();
    let kill = compile(
        killed.iter().map(|&call| (call, vec![])).collect(),
        SeccompAction::Allow,
        SeccompAction::KillProcess,
    )?;
    let no_clone3 = compile(
        BTreeMap::from([(libc::SYS_clone3, vec![])]),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
    )?;
    let allowed = allow_list(sockets)?;
    let count = allowed.len();
    let mismatch = match mode {
        Mode::Enforce => SeccompAction::Errno(libc::EPERM as u32),
        Mode::Log => SeccompAction::Log,
    };
    let allow = compile(allowed, mismatch, SeccompAction::Allow)?;
    // The allow-list goes on last: installing a filter takes prctl(PR_SET_NO_NEW_PRIVS) and seccomp(2), which it
    // refuses. The order doesn't change the outcome: the kernel runs every filter and takes the most restrictive
    // answer (kill, then errno, then allow).
    // TSYNC (apply_filter_all_threads): every thread that already exists gets the filters too, so a thread started
    // before hardening (an allocator's, say) can't be a way around them. It fails, rather than half-applying, if a
    // thread can't take them.
    for program in [&kill, &no_clone3, &allow] {
        seccompiler::apply_filter_all_threads(program).map_err(|e| anyhow!("seccomp: {e}"))?;
    }
    Ok(Report { mode, sockets, allowed: count, killed: killed.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test installs the filter in a child process: it can't be undone, and the test runner's other threads
    // must not inherit it.
    fn in_child(body: impl FnOnce() -> i32) -> (bool, i32) {
        // SAFETY: fork in a test; the child runs `body` and exits without returning to the runner.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed");
        if pid == 0 {
            // No core dump: several tests end the child with SIGSYS on purpose, and a dump would carry this process's
            // environment into the working directory.
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) };
            let code = body();
            unsafe { libc::_exit(code) };
        }
        let mut status = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        (libc::WIFSIGNALED(status), if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { libc::WTERMSIG(status) })
    }

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    #[test]
    fn threads_files_and_ipv4_sockets_still_work() {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixAndIpv4).is_err() {
                return 10;
            }
            // A thread (through clone3 → ENOSYS → clone with CLONE_THREAD).
            if std::thread::spawn(|| 7).join().ok() != Some(7) {
                return 11;
            }
            if std::fs::read("/proc/self/stat").is_err() {
                return 12;
            }
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
            if fd < 0 {
                return 13;
            }
            let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
            if fd < 0 {
                return 14;
            }
            0
        });
        assert!(!signalled && code == 0, "child failed with {code} (signalled: {signalled})");
    }

    #[test]
    fn refuses_other_socket_families_and_ioctls() {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixAndIpv4).is_err() {
                return 10;
            }
            let fd = unsafe { libc::socket(libc::AF_PACKET, libc::SOCK_RAW, 0) };
            if fd >= 0 || errno() != libc::EPERM {
                return 11;
            }
            let fd = unsafe { libc::socket(libc::AF_INET6, libc::SOCK_STREAM, 0) };
            if fd >= 0 || errno() != libc::EPERM {
                return 12;
            }
            let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW, 0) };
            if fd >= 0 || errno() != libc::EPERM {
                return 13;
            }
            // TIOCSTI (push a character into a terminal's input) is the classic ioctl to keep out.
            let r = unsafe { libc::ioctl(0, libc::TIOCSTI, b"x".as_ptr()) };
            if r == 0 || errno() != libc::EPERM {
                return 14;
            }
            // A prctl outside the list.
            let r = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) };
            if r == 0 || errno() != libc::EPERM {
                return 15;
            }
            0
        });
        assert!(!signalled && code == 0, "child failed with {code} (signalled: {signalled})");
    }

    #[test]
    fn unix_only_refuses_ipv4() {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixOnly).is_err() {
                return 10;
            }
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
            if fd >= 0 || errno() != libc::EPERM {
                return 11;
            }
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
            if fd >= 0 || errno() != libc::EPERM {
                return 12;
            }
            if unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) } < 0 {
                return 13;
            }
            0
        });
        assert!(!signalled && code == 0, "child failed with {code} (signalled: {signalled})");
    }

    #[test]
    fn a_new_process_is_refused() {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixAndIpv4).is_err() {
                return 10;
            }
            // fork is glibc's clone without CLONE_THREAD.
            let pid = unsafe { libc::fork() };
            if pid == 0 {
                unsafe { libc::_exit(0) };
            }
            if pid > 0 || errno() != libc::EPERM {
                return 11;
            }
            0
        });
        assert!(!signalled && code == 0, "child failed with {code} (signalled: {signalled})");
    }

    #[test]
    fn exec_kills_the_process() {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixAndIpv4).is_err() {
                return 10;
            }
            let path = c"/bin/true";
            let argv = [path.as_ptr(), std::ptr::null()];
            let envp = [std::ptr::null()];
            unsafe { libc::execve(path.as_ptr(), argv.as_ptr(), envp.as_ptr()) };
            // Not reached when the filter works.
            20
        });
        assert!(signalled && code == libc::SIGSYS, "execve should kill with SIGSYS; got code {code}, signalled {signalled}");
    }

    #[test]
    fn ptrace_and_unshare_kill_the_process() {
        for (name, call) in [
            ("ptrace", (|| unsafe { libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) as i64 }) as fn() -> i64),
            ("unshare", || unsafe { libc::unshare(libc::CLONE_NEWUSER) as i64 }),
        ] {
            let (signalled, code) = in_child(|| {
                if install(Mode::Enforce, Sockets::UnixAndIpv4).is_err() {
                    return 10;
                }
                call();
                20
            });
            assert!(signalled && code == libc::SIGSYS, "{name} should kill with SIGSYS; got {code}, signalled {signalled}");
        }
    }
}
