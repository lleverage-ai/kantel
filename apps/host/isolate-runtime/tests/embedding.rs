//! The library as another program uses it: its own guest bundle and its own ops, with the runtime's limits.

use std::time::Duration;

use deno_core::{OpState, op2};
use kantel_isolate::limits::Command;
use kantel_isolate::{Config, Ctx, Embedding, Engine, isolate::spawn_shell};
use serde_json::json;

/// An embedder's op: answers the sandbox the running command belongs to, and refuses outside a shell.
#[op2]
#[string]
fn op_demo_sandbox(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
    match Ctx::of(state) {
        Some(ctx) if ctx.kind == kantel_isolate::Kind::Shell => Ok(ctx.sandbox_id.to_string()),
        _ => Err(deno_error::JsErrorBox::generic("not available here")),
    }
}

deno_core::extension!(demo, ops = [op_demo_sandbox]);

/// The smallest guest bundle the contract allows: `__kantel.init(kind)` takes the ops, removes every route to them
/// from the global, and returns the shell's `exec` entry.
const GUEST: &str = r#"
globalThis.__kantel = {
  init(kind) {
    const ops = Deno.core.ops;
    for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
    return {
      exec: async (json) => {
        const request = JSON.parse(json);
        if (request.command === "spin") for (;;) {}
        const reach = typeof Deno === "undefined" && typeof __kantel === "undefined" ? "sealed" : "open";
        let evalRefused = false;
        try { eval("1"); } catch { evalRefused = true; }
        return JSON.stringify({
          exitCode: 0,
          stdout: `${kind} ${ops.op_demo_sandbox()} ${request.command} ${reach} eval-refused=${evalRefused}`,
          stderr: "",
          manifest: request.manifest,
          changed: [],
        });
      },
    };
  },
};
"#;

#[test]
fn an_embedder_runs_its_own_guest_and_ops() {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().unwrap();
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    let embedding = Embedding::new(GUEST).with_extensions(|| vec![demo::init()]);
    Engine::init(cfg, embedding, io.handle().clone(), false).unwrap();

    let shell = spawn_shell("sandbox-1".into(), 128, false);
    let command = Command::new(Duration::from_secs(5), Duration::from_secs(5));
    let reply = io
        .block_on(
            shell.exec(
                &json!({ "command": "hello", "manifest": {} }),
                json!({}),
                kantel_isolate::engine()
                    .filesystem
                    .open("sandbox-1", &json!({}))
                    .unwrap(),
                command,
            ),
        )
        .unwrap();
    assert_eq!(
        reply["stdout"], "shell sandbox-1 hello sealed eval-refused=true",
        "{reply}"
    );

    // The runtime's limits hold for an embedder's guest too: a command past its wall clock is stopped, and the
    // sandbox's isolate is kept for its next command.
    let spin = Command::new(Duration::from_secs(5), Duration::from_millis(300));
    let reply = io
        .block_on(
            shell.exec(
                &json!({ "command": "spin", "manifest": {} }),
                json!({}),
                kantel_isolate::engine()
                    .filesystem
                    .open("sandbox-1", &json!({}))
                    .unwrap(),
                spin,
            ),
        )
        .unwrap();
    assert_eq!(reply["terminated"], "wall", "{reply}");
    assert_eq!(reply["exitCode"], 152, "{reply}");
    let again = Command::new(Duration::from_secs(5), Duration::from_secs(5));
    let reply = io
        .block_on(
            shell.exec(
                &json!({ "command": "again", "manifest": {} }),
                json!({}),
                kantel_isolate::engine()
                    .filesystem
                    .open("sandbox-1", &json!({}))
                    .unwrap(),
                again,
            ),
        )
        .unwrap();
    assert_eq!(
        reply["stdout"], "shell sandbox-1 again sealed eval-refused=true",
        "{reply}"
    );
}
