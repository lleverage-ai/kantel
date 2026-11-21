//! The process-hardening tests (hardening/: seccomp and Landlock), each in a child process the test forks: a filter or
//! a ruleset can't be undone, and the runner's other threads mustn't inherit it. They run one at a time on this
//! binary's only thread (`harness = false`), so no other thread holds a lock a child would inherit locked when it
//! forks — in the shared unit-test binary one did, and a child deadlocked in its first thread spawn (Main, 21 Nov
//! 2026). A child that doesn't finish in time is killed and its test fails, rather than the test waiting forever.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kantel_isolate::hardening::landlock::{Policy, Transport, restrict};
use kantel_isolate::hardening::seccomp::{Mode, Sockets, install};

/// How long a child may take before it is killed and its test fails.
const CHILD_LIMIT: Duration = Duration::from_secs(30);

/// Fork, run `body` in the child (which exits with its result), and answer (signalled, exit code or signal).
fn in_child(body: impl FnOnce() -> i32) -> (bool, i32) {
    // SAFETY: fork from this binary's only thread; the child runs `body` and exits without returning.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        // No core dump: several tests end the child with SIGSYS on purpose, and a dump would carry this process's
        // environment into the working directory.
        let none = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) };
        let code = body();
        unsafe { libc::_exit(code) };
    }
    let started = Instant::now();
    let mut status = 0;
    loop {
        let done = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if done == pid {
            break;
        }
        if started.elapsed() > CHILD_LIMIT {
            unsafe { libc::kill(pid, libc::SIGKILL) };
            unsafe { libc::waitpid(pid, &mut status, 0) };
            panic!("the child didn't finish in {CHILD_LIMIT:?}: killed");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    (
        libc::WIFSIGNALED(status),
        if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            libc::WTERMSIG(status)
        },
    )
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn threads_files_and_ipv4_sockets_still_work() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixAndIpv4, false).is_err() {
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
    assert!(
        !signalled && code == 0,
        "child failed with {code} (signalled: {signalled})"
    );
}

fn refuses_other_socket_families_and_ioctls() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixAndIpv4, false).is_err() {
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
    assert!(
        !signalled && code == 0,
        "child failed with {code} (signalled: {signalled})"
    );
}

fn unix_only_refuses_ipv4() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixOnly, false).is_err() {
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
    assert!(
        !signalled && code == 0,
        "child failed with {code} (signalled: {signalled})"
    );
}

fn a_new_process_is_refused() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixAndIpv4, false).is_err() {
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
    assert!(
        !signalled && code == 0,
        "child failed with {code} (signalled: {signalled})"
    );
}

fn exec_kills_the_process() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixAndIpv4, false).is_err() {
            return 10;
        }
        let path = c"/bin/true";
        let argv = [path.as_ptr(), std::ptr::null()];
        let envp = [std::ptr::null()];
        unsafe { libc::execve(path.as_ptr(), argv.as_ptr(), envp.as_ptr()) };
        // Not reached when the filter works.
        20
    });
    assert!(
        signalled && code == libc::SIGSYS,
        "execve should kill with SIGSYS; got code {code}, signalled {signalled}"
    );
}

fn ptrace_and_unshare_kill_the_process() {
    for (name, call) in [
        (
            "ptrace",
            (|| unsafe { libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) as i64 }) as fn() -> i64,
        ),
        ("unshare", || unsafe {
            libc::unshare(libc::CLONE_NEWUSER) as i64
        }),
    ] {
        let (signalled, code) = in_child(|| {
            if install(Mode::Enforce, Sockets::UnixAndIpv4, false).is_err() {
                return 10;
            }
            call();
            20
        });
        assert!(
            signalled && code == libc::SIGSYS,
            "{name} should kill with SIGSYS; got {code}, signalled {signalled}"
        );
    }
}

fn spawn_allows_a_child_process_but_no_namespaces() {
    let (signalled, code) = in_child(|| {
        if install(Mode::Enforce, Sockets::UnixAndIpv4, true).is_err() {
            return 10;
        }
        // posix_spawn (clone3, refused with ENOSYS, then clone with CLONE_VM | CLONE_VFORK) and exec.
        match std::process::Command::new("/bin/true").status() {
            Ok(status) if status.success() => {}
            _ => return 11,
        }
        // fork, and waiting for the child.
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            unsafe { libc::_exit(3) };
        }
        let mut status = 0;
        if pid < 0 || unsafe { libc::waitpid(pid, &mut status, 0) } != pid {
            return 12;
        }
        if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 3 {
            return 13;
        }
        // A process in a new user namespace is still refused.
        let r = unsafe {
            libc::syscall(
                libc::SYS_clone,
                (libc::CLONE_NEWUSER | libc::SIGCHLD) as libc::c_ulong,
                0usize,
                0usize,
                0usize,
                0usize,
            )
        };
        if r == 0 {
            unsafe { libc::_exit(0) };
        }
        if r > 0 || errno() != libc::EPERM {
            return 14;
        }
        0
    });
    assert!(
        !signalled && code == 0,
        "child failed with {code} (signalled: {signalled})"
    );
}

fn writable_places_are_never_executable_and_execute_paths_are() {
    let work = std::env::temp_dir().join(format!("kt-landlock-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let copy = work.join("true");
    std::fs::copy("/bin/true", &copy).unwrap();
    // Only meaningful where the copy can run before Landlock is applied (not on a noexec temporary directory).
    if !std::process::Command::new(&copy)
        .status()
        .is_ok_and(|s| s.success())
    {
        let _ = std::fs::remove_dir_all(&work);
        eprintln!("skipped: {} can't be executed here", copy.display());
        return;
    }
    // SAFETY: fork in a test; the child restricts itself and exits without returning to the runner.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        let none = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) };
        let execute = ["/usr", "/bin", "/lib", "/lib64"]
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .collect();
        let policy = Policy {
            assets: work.clone(),
            temp: work.clone(),
            extra_read: vec![],
            read_write: vec![],
            execute,
            transport: Transport::Tcp {
                listen: 0,
                connect: vec![],
            },
        };
        let code = match restrict(&policy) {
            // No Landlock on this kernel: nothing to check.
            Ok(report) if report.status.starts_with("not enforced") => 0,
            Ok(_) => {
                let run = |path: &Path| std::process::Command::new(path).status();
                match (run(Path::new("/bin/true")), run(&copy)) {
                    (Ok(ok), Err(e)) if ok.success() && e.raw_os_error() == Some(libc::EACCES) => 0,
                    (allowed, written) => {
                        let _ = std::fs::write(
                            work.join("debug"),
                            format!("/bin/true: {allowed:?}; written copy: {written:?}"),
                        );
                        1
                    }
                }
            }
            Err(e) => {
                eprintln!("restrict: {e:#}");
                2
            }
        };
        unsafe { libc::_exit(code) };
    }
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    let debug = std::fs::read_to_string(work.join("debug")).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&work);
    assert!(
        libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
        "child status {status}: {debug}"
    );
}

fn main() {
    let tests: &[(&str, fn())] = &[
        (
            "threads_files_and_ipv4_sockets_still_work",
            threads_files_and_ipv4_sockets_still_work,
        ),
        (
            "refuses_other_socket_families_and_ioctls",
            refuses_other_socket_families_and_ioctls,
        ),
        ("unix_only_refuses_ipv4", unix_only_refuses_ipv4),
        ("a_new_process_is_refused", a_new_process_is_refused),
        ("exec_kills_the_process", exec_kills_the_process),
        (
            "ptrace_and_unshare_kill_the_process",
            ptrace_and_unshare_kill_the_process,
        ),
        (
            "spawn_allows_a_child_process_but_no_namespaces",
            spawn_allows_a_child_process_but_no_namespaces,
        ),
        (
            "writable_places_are_never_executable_and_execute_paths_are",
            writable_places_are_never_executable_and_execute_paths_are,
        ),
    ];
    let mut failed = 0;
    for (name, test) in tests {
        match std::panic::catch_unwind(test) {
            Ok(()) => println!("test {name} ... ok"),
            Err(_) => {
                println!("test {name} ... FAILED");
                failed += 1;
            }
        }
    }
    println!(
        "test result: {}. {} passed; {failed} failed",
        if failed == 0 { "ok" } else { "FAILED" },
        tests.len() - failed
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
