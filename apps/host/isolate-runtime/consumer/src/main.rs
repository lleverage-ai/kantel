//! A minimal embedder of kantel-isolate: its own guest bundle and one op of its own, one shell command, the reply
//! printed. Exits non-zero if the runtime doesn't answer as the embedding contract (EMBEDDING.md) says.

use std::time::Duration;

use anyhow::{Result, ensure};
use deno_core::{OpState, op2};
use kantel_isolate::limits::Command;
use kantel_isolate::{Config, Ctx, Embedding, Engine, Kind};

/// The embedder's op: the sandbox the running command belongs to, for shell isolates only.
#[op2]
#[string]
fn op_consumer_sandbox(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
    match Ctx::of(state) {
        Some(ctx) if ctx.kind == Kind::Shell => Ok(ctx.sandbox_id.to_string()),
        _ => Err(deno_error::JsErrorBox::generic("not available here")),
    }
}

deno_core::extension!(consumer, ops = [op_consumer_sandbox]);

const GUEST: &str = r#"
globalThis.__kantel = {
  init(kind) {
    const ops = Deno.core.ops;
    for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
    return {
      exec: async (json) => {
        const { command } = JSON.parse(json);
        return JSON.stringify({ exitCode: 0, stdout: `${kind}:${ops.op_consumer_sandbox()}:${command}`, stderr: "" });
      },
    };
  },
};
"#;

fn main() -> Result<()> {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new()?;
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    let embedding = Embedding::new(GUEST).with_extensions(|| vec![consumer::init()]);
    Engine::init(cfg, embedding, io.handle().clone(), false)?;
    let shell = kantel_isolate::isolate::spawn_shell("consumer".into(), 128, false);
    let command = Command::new(Duration::from_secs(5), Duration::from_secs(5));
    let reply = io.block_on(
        shell.exec(
            &serde_json::json!({ "command": "hello" }),
            serde_json::json!({}),
            kantel_isolate::engine()
                .filesystem
                .open("consumer", &serde_json::json!({}))?,
            command,
        ),
    )?;
    println!(
        "{}",
        serde_json::json!({ "reply": reply, "runtime": kantel_isolate::version_info() })
    );
    ensure!(
        reply["stdout"] == "shell:consumer:hello",
        "unexpected reply {reply}"
    );
    ensure!(
        kantel_isolate::v8_sandbox_enabled() == cfg!(feature = "v8-sandbox"),
        "V8's heap sandbox is {} in a build {} the v8-sandbox feature",
        if kantel_isolate::v8_sandbox_enabled() {
            "on"
        } else {
            "off"
        },
        if cfg!(feature = "v8-sandbox") {
            "with"
        } else {
            "without"
        },
    );
    Ok(())
}
