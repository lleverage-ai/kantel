//! One allocation far past an isolate's memory limit stops only that isolate's run, and the process goes on serving:
//! a node run, a shell isolate (reused for the sandbox's next command) and an embedder's own isolate, with the
//! largest single objects V8 makes (a 400 MB array of doubles, a string of about 1 GiB) and with ArrayBuffers and
//! WebAssembly memory, which the heap limit doesn't hold.
//!
//! A process V8 ends on running out of memory can't report a failed assertion, so each case runs in a child process
//! the test forks, one at a time on this binary's only thread (`harness = false`, as tests/hardening.rs), with V8
//! started in the child. A child that doesn't finish in time is killed and its test fails. Needs the guest bundle
//! (`bun run guest/build.ts`), as the binary does.

use std::sync::Arc;
use std::time::{Duration, Instant};

use deno_core::{JsRuntime, RuntimeOptions, v8};
use kantel_isolate::isolate::{ShellHandle, spawn_shell};
use kantel_isolate::limits::Command;
use kantel_isolate::memory::{self, Budget, Term};
use kantel_isolate::workspace::ManifestProvider;
use kantel_isolate::workspace::contract::subjects::MemoryBlobs;
use kantel_isolate::{Config, Embedding, Engine};
use serde_json::{Value, json};

const GUEST: &str = include_str!("../guest/dist/guest.js");

/// How long a child may take before it is killed and its test fails.
const CHILD_LIMIT: Duration = Duration::from_secs(180);

/// One case: Ok, or what went wrong.
type Case = fn() -> Result<(), String>;

/// Fork, run `body` in the child, and say how it ended: Ok, or why not (its error, or the signal that ended it).
fn in_child(body: Case) -> Result<(), String> {
    // SAFETY: fork from this binary's only thread; the child runs `body` and exits without returning.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        // No core dump: a child V8 ends would leave one carrying this process's environment in the working directory.
        let none = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) };
        let code = match body() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        };
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
            return Err(format!("didn't finish in {CHILD_LIMIT:?}: killed"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if libc::WIFSIGNALED(status) {
        return Err(format!(
            "the process was ended by signal {} (V8 ran out of memory and aborted it)",
            libc::WTERMSIG(status)
        ));
    }
    match libc::WEXITSTATUS(status) {
        0 => Ok(()),
        code => Err(format!(
            "the child failed (exit {code}); its error is above"
        )),
    }
}

fn check(ok: bool, what: &str, reply: &Value) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(format!("{what}: {reply}"))
    }
}

fn start(embedding: Embedding) -> tokio::runtime::Runtime {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().expect("tokio");
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    Engine::init(cfg, embedding, io.handle().clone(), false).expect("engine");
    io
}

async fn exec(shell: &ShellHandle, command: &str) -> Value {
    let body = json!({ "command": command, "manifest": {} });
    let prepared = kantel_isolate::server::prepare("oom", &body)
        .await
        .expect("prepare");
    shell
        .exec(
            &prepared.request,
            prepared.manifest,
            prepared.workspace,
            Command::new(Duration::from_secs(60), Duration::from_secs(60)),
        )
        .await
        .expect("exec")
}

/// node runs in a 128 MiB sandbox: each oversized allocation stops its run (`terminated: memory`), and the shell and
/// the next run go on.
fn node_runs_survive_oversized_allocations() -> Result<(), String> {
    let io = start(
        Embedding::new(GUEST).with_filesystem(Arc::new(ManifestProvider::new(Arc::new(
            MemoryBlobs::default(),
        )))),
    );
    let shell = spawn_shell("oom".into(), 128, false);
    io.block_on(async {
        // 5e7 doubles: one 400 MB FixedDoubleArray.
        let reply = exec(&shell, "node -e 'new Array(5e7).fill(1.5)'").await;
        check(
            reply["terminated"] == "memory" && reply["exitCode"] == 137,
            "a 400 MB array",
            &reply,
        )?;
        // The largest array of doubles there is (1 GiB), made from a tagged one about as large: two large objects in
        // one builtin.
        let reply = exec(&shell, "node -e 'new Array(2 ** 27).fill(1.5)'").await;
        check(
            reply["terminated"] == "memory" && reply["exitCode"] == 137,
            "a 1 GiB array",
            &reply,
        )?;
        // A two-byte string of String::kMaxLength characters, flattened: just under 1 GiB.
        let reply = exec(
            &shell,
            r#"node -e 's = "ሴ".repeat(2 ** 29 - 24); console.log(s.indexOf("x"))'"#,
        )
        .await;
        check(
            reply["terminated"] == "memory" && reply["exitCode"] == 137,
            "a string of about 1 GiB",
            &reply,
        )?;
        // Two of them in one builtin, after the stop was asked for: the string flattened, then its copy.
        let reply = exec(
            &shell,
            r#"node -e 's = "ሴ".repeat(2 ** 29 - 24); console.log(s.toUpperCase().length)'"#,
        )
        .await;
        check(
            reply["terminated"] == "memory" && reply["exitCode"] == 137,
            "two strings of about 1 GiB",
            &reply,
        )?;
        // Outside the heap: refused by the budget (a RangeError the run doesn't catch, or the run stopped).
        for (what, code) in [
            ("a 400 MB ArrayBuffer", "new Uint8Array(400 * 2 ** 20)"),
            (
                "400 MB of WebAssembly memory",
                "new WebAssembly.Memory({ initial: 6400 })",
            ),
        ] {
            let reply = exec(&shell, &format!("node -e '{code}'")).await;
            check(
                reply["exitCode"] == 1 || reply["terminated"] == "memory",
                what,
                &reply,
            )?;
        }
        // The process serves the next command and the next run.
        let reply = exec(&shell, "echo ok && node -e 'console.log(6 * 7)'").await;
        check(
            reply["exitCode"] == 0 && reply["stdout"] == "ok\n42\n",
            "the next command",
            &reply,
        )
    })
}

/// An embedder's guest whose `exec` makes one 400 MB array when asked: its shell isolate is stopped and reused.
const BIG_GUEST: &str = r#"
globalThis.__kantel = {
  init(kind) {
    for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
    return {
      exec: async (json) => {
        const request = JSON.parse(json);
        if (request.command === "big") new Array(5e7).fill(1.5);
        return JSON.stringify({ exitCode: 0, stdout: request.command, stderr: "", manifest: request.manifest, changed: [] });
      },
    };
  },
};
"#;

/// A 64 MiB shell isolate: the oversized allocation stops the command, and the isolate serves the next one, twice
/// over (the heap guard is re-armed on reuse).
fn a_shell_isolate_survives_one_and_is_reused() -> Result<(), String> {
    let io = start(Embedding::new(BIG_GUEST));
    let shell = spawn_shell("oom".into(), 64, false);
    let run = |command: &str| {
        let workspace = kantel_isolate::engine()
            .filesystem
            .open("oom", &json!({}))
            .expect("workspace");
        io.block_on(shell.exec(
            &json!({ "command": command, "manifest": {} }),
            json!({}),
            workspace,
            Command::new(Duration::from_secs(60), Duration::from_secs(60)),
        ))
        .expect("exec")
    };
    for _ in 0..2 {
        let reply = run("big");
        check(
            reply["terminated"] == "memory" && reply["exitCode"] == 137,
            "a 400 MB array in the shell",
            &reply,
        )?;
        let reply = run("hello");
        check(reply["stdout"] == "hello", "the next command", &reply)?;
    }
    Ok(())
}

/// An isolate the embedder makes itself, held to its budget with `memory::watch`: stopped, not the process.
fn an_embedders_own_isolate_survives_one() -> Result<(), String> {
    kantel_isolate::init_v8();
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio");
    let _entered = tokio.enter();
    let budget = Budget::new(64 << 20);
    let mut rt = JsRuntime::new(RuntimeOptions {
        create_params: Some(memory::create_params(&budget)),
        ..Default::default()
    });
    let mut watch = memory::watch(&mut rt, &budget);
    let running = memory::enforce(
        &mut rt,
        &budget,
        Duration::from_secs(60),
        Duration::from_secs(60),
    )
    .map_err(|e| e.to_string())?;
    // The stop lands once the builtin making the array returns: the loop after it never ends otherwise.
    let result = rt.execute_script("oom", "new Array(5e7).fill(1.5); for (;;) {}");
    let term = running.watched().term();
    drop(running);
    rt.v8_isolate().cancel_terminate_execution();
    if result.is_ok() || term != Some(Term::Memory) {
        return Err(format!(
            "the run wasn't stopped for its memory: {:?}, {term:?}",
            result.map(|_| ())
        ));
    }
    // The isolate still runs code.
    let value = rt
        .execute_script("after", "6 * 7")
        .map_err(|e| e.to_string())?;
    {
        deno_core::scope!(scope, &mut rt);
        let local = v8::Local::new(scope, value);
        if local.to_rust_string_lossy(scope) != "42" {
            return Err("the isolate didn't run code after its stop".into());
        }
    }
    watch.remove(&mut rt);
    Ok(())
}

fn main() {
    let tests: &[(&str, Case)] = &[
        (
            "node_runs_survive_oversized_allocations",
            node_runs_survive_oversized_allocations,
        ),
        (
            "a_shell_isolate_survives_one_and_is_reused",
            a_shell_isolate_survives_one_and_is_reused,
        ),
        (
            "an_embedders_own_isolate_survives_one",
            an_embedders_own_isolate_survives_one,
        ),
    ];
    let filter = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let mut failed = 0;
    let mut ran = 0;
    for (name, test) in tests {
        if filter.as_deref().is_some_and(|f| !name.contains(f)) {
            continue;
        }
        ran += 1;
        match in_child(*test) {
            Ok(()) => println!("test {name} ... ok"),
            Err(e) => {
                println!("test {name} ... FAILED: {e}");
                failed += 1;
            }
        }
    }
    println!(
        "test result: {}. {} passed; {failed} failed",
        if failed == 0 { "ok" } else { "FAILED" },
        ran - failed
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
