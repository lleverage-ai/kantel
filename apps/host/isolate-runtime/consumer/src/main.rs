//! A minimal embedder of kantel-isolate: its own guest bundle and one op of its own, a filesystem provider and a host
//! command, one shell command, the reply printed. Exits non-zero if the runtime doesn't answer as the embedding
//! contract (EMBEDDING.md) says.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, ensure};
use deno_core::{OpState, op2};
use kantel_isolate::host_commands::{HostCommand, HostReply, HostRequest};
use kantel_isolate::limits::Command;
use kantel_isolate::workspace::contract::{self, Persistent, Resolution, subjects};
use kantel_isolate::workspace::memory::RecordProvider;
use kantel_isolate::workspace::{BoxFuture, Node};
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

/// The embedder's host command, `peek FILE`: where the file's bytes are, its size, bytes 4 to 8 of it (a ranged read)
/// and the size of the whole of it as the host reads it (not held to the isolate's read cap).
struct Peek;
impl HostCommand for Peek {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            let path = request.args.first().cloned().unwrap_or_default();
            let file = request
                .files
                .file(&path)
                .ok_or_else(|| anyhow!("{path}: no such file"))?;
            let range = request.files.read_range(&path, 4, 4).await?;
            let whole = request.files.read(&path, 1 << 20).await?;
            let at = if file.id.is_some() {
                "workspace"
            } else {
                "shell"
            };
            Ok(HostReply {
                stdout: format!(
                    "{at} {} {} {}",
                    file.size,
                    String::from_utf8_lossy(&range),
                    whole.len()
                )
                .into_bytes(),
                ..Default::default()
            })
        })
    }
}

// The guest runs the host command itself (Kantel's guest shell would, for a command of its name), naming the one file
// the request gives.
const GUEST: &str = r#"
globalThis.__kantel = {
  init(kind) {
    const core = Deno.core;
    const ops = core.ops;
    for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
    return {
      exec: async (json) => {
        const { command, file, size } = JSON.parse(json);
        const meta = {
          name: "peek", args: ["big.txt"], cwd: "/workspace", env: {}, runId: 1,
          index: { "big.txt": { kind: "file", sha: file, size } },
        };
        const raw = await ops.op_kt_host_command(JSON.stringify(meta), new Uint8Array(0));
        const n = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0);
        const reply = JSON.parse(core.decode(raw.subarray(4, 4 + n)));
        const [at, len] = reply.stdout;
        const peek = core.decode(raw.subarray(4 + n + at, 4 + n + at + len));
        return JSON.stringify({ exitCode: 0, stdout: `${kind}:${ops.op_consumer_sandbox()}:${command}`, stderr: "", peek });
      },
    };
  },
};
"#;

fn main() -> Result<()> {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new()?;

    // The provider contract, as an embedder runs it against its own provider (here the reference one).
    let subject = subjects::Record::default();
    ensure!(subject.lost_reply_resolution() == Resolution::Unknown);
    io.block_on(async {
        contract::common(&subject).await;
        contract::persistent(&subject).await;
    });

    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    // A guest may read at most 4 bytes of a file; a host command isn't held to that.
    let records = Arc::new(RecordProvider::new(4));
    records.seed("consumer", &[("big.txt", b"0123456789")]);
    let embedding = Embedding::new(GUEST)
        .with_extensions(|| vec![consumer::init()])
        .with_filesystem(records)
        .with_host_command("peek", Arc::new(Peek));
    Engine::init(cfg, embedding, io.handle().clone(), false)?;
    let workspace = kantel_isolate::engine()
        .filesystem
        .open("consumer", &serde_json::json!({}))?;
    let view = io.block_on(workspace.view())?;
    let Some(Node::File { file, size, .. }) = view.entries.get("big.txt") else {
        anyhow::bail!("the seeded file isn't in the view: {view:?}");
    };
    let shell = kantel_isolate::isolate::spawn_shell("consumer".into(), 128, false);
    let command = Command::new(Duration::from_secs(5), Duration::from_secs(5));
    let reply = io.block_on(shell.exec(
        &serde_json::json!({ "command": "hello", "file": file, "size": size }),
        serde_json::json!({}),
        workspace,
        command,
    ))?;
    println!(
        "{}",
        serde_json::json!({ "reply": reply, "runtime": kantel_isolate::version_info() })
    );
    ensure!(
        reply["stdout"] == "shell:consumer:hello",
        "unexpected reply {reply}"
    );
    ensure!(
        reply["peek"] == "workspace 10 4567 10",
        "unexpected host command reply {reply}"
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
