//! An embedder's own isolate kind: its isolates get their own `__kantel.init`, start with code generation from strings
//! off, and get the kind's runtime already evaluated (once, into the startup snapshot, not per isolate), which no other
//! kind's isolate can reach. They live alongside the runtime's own isolates. And the memory such an isolate holds
//! outside its heap, as the embedder reads it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use deno_core::{OpState, op2, v8};
use kantel_isolate::isolate::{Live, ShellHandle, spawn_shell, try_new_live};
use kantel_isolate::limits::Command;
use kantel_isolate::{Config, Embedding, Engine, Kind};
use serde_json::{Value, json};

/// Times the program kind's runtime has been evaluated, in this process.
static RUNTIME_LOADS: AtomicUsize = AtomicUsize::new(0);

#[op2(fast)]
#[smi]
fn op_demo_runtime_loaded(_state: &mut OpState) -> u32 {
    RUNTIME_LOADS.fetch_add(1, Ordering::SeqCst) as u32 + 1
}

deno_core::extension!(demo, ops = [op_demo_runtime_loaded]);

/// `init(kind, runtime)`: a shell's `exec` says what it can see; any other kind's `describe` says what it got.
const GUEST: &str = r#"
globalThis.__kantel = {
  init(kind, runtime) {
    for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
    let codegen = true;
    try { eval("1"); } catch { codegen = false; }
    const seen = {
      kind,
      args: arguments.length,
      codegen,
      holder: typeof globalThis.__kantelKinds,
      loads: runtime?.loads ?? 0,
    };
    if (kind === "shell") {
      return {
        exec: async (json) => {
          const request = JSON.parse(json);
          return JSON.stringify({ exitCode: 0, stdout: JSON.stringify(seen), stderr: "", manifest: request.manifest, changed: [] });
        },
      };
    }
    return { describe: () => JSON.stringify(seen), runtime };
  },
};
"#;

/// The program kind's runtime: counts its evaluations and hands its kind an object.
const PROGRAM: &str = "const loads = Deno.core.ops.op_demo_runtime_loaded();\nreturn { loads };";

fn eval(live: &mut Live, code: &'static str) -> String {
    let value = live.rt.execute_script("test", code).expect("script");
    deno_core::scope!(scope, &mut live.rt);
    let local = v8::Local::new(scope, value);
    local.to_rust_string_lossy(scope)
}

fn describe(live: &mut Live) -> Value {
    serde_json::from_str(&eval(live, "globalThis.__kantelEntry.describe()")).expect("json")
}

/// A runtime of some size (a bundle of functions), to time evaluating it per isolate against starting with it.
fn big_runtime() -> &'static str {
    let mut js = String::from("const fns = [];\n");
    for i in 0..4000 {
        js.push_str(&format!(
            "function f{i}(a) {{ return a.map((x) => x * {i}).filter(Boolean).length + {i}; }}\nfns.push(f{i});\n"
        ));
    }
    js.push_str("return fns;\n");
    Box::leak(js.into_boxed_str())
}

fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}

fn shell_sees(io: &tokio::runtime::Runtime, shell: &ShellHandle) -> Value {
    let reply = io
        .block_on(
            shell.exec(
                &json!({ "command": "x", "manifest": {} }),
                json!({}),
                kantel_isolate::engine()
                    .filesystem
                    .open("kinds", &json!({}))
                    .unwrap(),
                Command::new(Duration::from_secs(5), Duration::from_secs(5)),
            ),
        )
        .unwrap();
    serde_json::from_str(reply["stdout"].as_str().unwrap_or_default()).expect("shell reply")
}

#[test]
fn an_embedders_kind_gets_its_runtime_from_the_snapshot() {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().unwrap();
    let cfg = || Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    let base = || Embedding::new(GUEST).with_extensions(|| vec![demo::init()]);

    // A kind may not take a runtime kind's name, an empty one, or one given twice, and its runtime may not leave
    // anything on the global.
    for embedding in [
        base().with_kind("node", ""),
        base().with_kind("", ""),
        base().with_kind("program", "").with_kind("program", ""),
        base().with_kind("leaky", "globalThis.leaked = 1; return 0;"),
        base().with_kind(
            "symbolic",
            "globalThis[Symbol(\"leaked\")] = 1; return 0;",
        ),
        // A runtime that pins the holder, so isolates couldn't take it off.
        base().with_kind(
            "pinning",
            "Object.defineProperty(globalThis, \"__kantelKinds\", { configurable: false }); return 0;",
        ),
    ] {
        let refused = Engine::init(cfg(), embedding, io.handle().clone(), false);
        assert!(refused.is_err(), "an embedding with a bad kind was taken");
    }

    let big = big_runtime();
    let embedding = base()
        .with_kind("program", PROGRAM)
        .with_kind("plain", "")
        .with_kind("big", big);
    let started = Instant::now();
    Engine::init(cfg(), embedding, io.handle().clone(), false).unwrap();
    let init_time = started.elapsed();
    assert_eq!(
        RUNTIME_LOADS.load(Ordering::SeqCst),
        1,
        "the runtime is evaluated once, into the snapshot"
    );

    // A shell isolate, alive throughout, never sees the kinds' runtimes.
    let shell = spawn_shell("kinds".into(), 128, false);
    assert_eq!(
        shell_sees(&io, &shell),
        json!({ "kind": "shell", "args": 1, "codegen": false, "holder": "undefined", "loads": 0 })
    );

    let local = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = local.enter();

    // Its own init with its runtime, codegen off, in every isolate of the kind, beside the shell.
    for _ in 0..3 {
        let mut live = try_new_live(Kind::Embedder("program"), 64).unwrap();
        assert_eq!(
            describe(&mut live),
            json!({ "kind": "program", "args": 2, "codegen": false, "holder": "undefined", "loads": 1 })
        );
    }
    assert_eq!(RUNTIME_LOADS.load(Ordering::SeqCst), 1);

    // A kind without a runtime gets none, and the runtime's own kinds are as they were.
    let mut plain = try_new_live(Kind::Embedder("plain"), 64).unwrap();
    assert_eq!(
        describe(&mut plain),
        json!({ "kind": "plain", "args": 1, "codegen": false, "holder": "undefined", "loads": 0 })
    );
    assert_eq!(
        shell_sees(&io, &shell),
        json!({ "kind": "shell", "args": 1, "codegen": false, "holder": "undefined", "loads": 0 })
    );

    // A runtime kind's isolate gets no kind's runtime either, and keeps codegen.
    let mut node = try_new_live(Kind::Node, 64).unwrap();
    assert_eq!(
        describe(&mut node),
        json!({ "kind": "node", "args": 1, "codegen": true, "holder": "undefined", "loads": 0 })
    );
    drop(node);

    // A kind the embedding doesn't have is an error, not a panic.
    assert!(try_new_live(Kind::Embedder("missing"), 64).is_err());

    // What the isolate holds outside its heap: a buffer it keeps.
    let before = plain.budget.outside_heap();
    eval(&mut plain, "globalThis.kept = new ArrayBuffer(8 << 20); 0");
    let outside = plain.budget.outside_heap();
    assert!(
        outside >= before + (8 << 20),
        "the buffer isn't counted outside the heap: {before} then {outside}"
    );
    assert_eq!(
        plain.budget.total(),
        outside + plain.budget.heap(),
        "outside the heap and the heap make the total"
    );
    drop(plain);

    // The start-up an embedder saves: an isolate of a kind whose runtime is in the snapshot, against one that evaluates
    // the same runtime after it starts, and what the runtime adds to an isolate of another kind (printed with
    // --nocapture; timings aren't asserted).
    let evaluate = format!("globalThis.__fns = (function () {{\n{big}\n}})();");
    let (mut with_runtime, mut evaluated, mut other) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..9 {
        let started = Instant::now();
        let live = try_new_live(Kind::Embedder("big"), 64).unwrap();
        with_runtime.push(started.elapsed());
        drop(live);
        let started = Instant::now();
        let mut live = try_new_live(Kind::Embedder("plain"), 64).unwrap();
        live.rt.execute_script("big", evaluate.clone()).unwrap();
        evaluated.push(started.elapsed());
        drop(live);
        let started = Instant::now();
        let live = try_new_live(Kind::Shell, 64).unwrap();
        other.push(started.elapsed());
        drop(live);
    }
    println!(
        "start-up, median of 9: a kind with its runtime in the snapshot {:?}; a kind evaluating it per isolate {:?}; a shell isolate {:?}. Engine::init {init_time:?}, snapshot {} bytes, runtime source {} bytes",
        median(with_runtime),
        median(evaluated),
        median(other),
        kantel_isolate::engine().snapshot().len(),
        big.len(),
    );
}
