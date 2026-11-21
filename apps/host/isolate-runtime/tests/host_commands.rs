//! The embedder's host commands, run by Kantel's own guest shell: they read the shell's files as they are (one the
//! command just wrote included), hand back small outputs inline or commit large ones through the workspace
//! themselves, and a name the isolate otherwise lacks is served, not refused. Needs the guest bundle
//! (`bun run guest/build.ts`), as the binary does.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use kantel_isolate::host_commands::{HostCommand, HostReply, HostRequest};
use kantel_isolate::isolate::spawn_shell;
use kantel_isolate::limits::Command;
use kantel_isolate::workspace::contract::subjects::MemoryBlobs;
use kantel_isolate::workspace::{BoxFuture, Commit, CommitReply, ManifestProvider, Put};
use kantel_isolate::{Config, Embedding, Engine};
use serde_json::{Value, json};

const GUEST: &str = include_str!("../guest/dist/guest.js");

/// `upper FILE`: prints the file upper-cased and writes it to FILE.upper (an inline output).
struct Upper;
impl HostCommand for Upper {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            let name = request.args.first().cloned().unwrap_or_default();
            let bytes = request
                .files
                .read(&name, 1 << 20)
                .await?
                .to_ascii_uppercase();
            Ok(HostReply {
                stdout: bytes.clone(),
                writes: vec![(format!("{name}.upper"), bytes, None)],
                ..Default::default()
            })
        })
    }
}

/// `stash TEXT`: commits stash.txt through the workspace itself (a large output's way), saying so.
struct Stash;
impl HostCommand for Stash {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            let workspace = request.files.workspace().expect("a workspace").clone();
            let text = format!("{}\n", request.args.join(" "));
            let staged = workspace.stage("stash.txt", text.into_bytes()).await?;
            let now = workspace.view().await?;
            let reply = workspace
                .commit(Commit {
                    operation_id: "stash".into(),
                    base: now.generation,
                    puts: vec![Put {
                        path: "stash.txt".into(),
                        blob: staged.blob,
                        mode: None,
                    }],
                    ..Commit::default()
                })
                .await?;
            assert!(matches!(reply, CommitReply::Committed { .. }), "{reply:?}");
            Ok(HostReply {
                workspace_changed: true,
                ..Default::default()
            })
        })
    }
}

/// `unzip`: a name the isolate's shell would otherwise refuse as unavailable.
struct Served;
impl HostCommand for Served {
    fn run<'a>(&'a self, _request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            Ok(HostReply {
                stdout: b"served\n".to_vec(),
                ..Default::default()
            })
        })
    }
}

async fn run(
    shell: &kantel_isolate::isolate::ShellHandle,
    manifest: Value,
    command: &str,
) -> Value {
    let body = json!({ "command": command, "manifest": manifest });
    let prepared = kantel_isolate::server::prepare("h", &body)
        .await
        .expect("prepare");
    shell
        .exec(
            &prepared.request,
            prepared.manifest,
            prepared.workspace,
            Command::new(Duration::from_secs(20), Duration::from_secs(20)),
        )
        .await
        .expect("exec")
}

#[test]
fn an_embedders_host_commands_run_for_the_guest_shell() {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().unwrap();
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        ..Config::new(std::env::temp_dir())
    };
    let embedding = Embedding::new(GUEST)
        .with_filesystem(Arc::new(ManifestProvider::new(Arc::new(
            MemoryBlobs::default(),
        ))))
        .with_host_command("upper", Arc::new(Upper))
        .with_host_command("stash", Arc::new(Stash))
        .with_host_command("unzip", Arc::new(Served));
    Engine::init(cfg, embedding, io.handle().clone(), false).unwrap();
    let shell = spawn_shell("h".into(), 256, false);

    // Inline outputs, from a file the command wrote a moment before.
    let reply = io.block_on(run(
        &shell,
        json!({}),
        "echo hi > a.txt && upper a.txt && cat a.txt.upper",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "HI\nHI\n", "{reply}");
    let manifest = reply["manifest"].clone();
    assert!(
        manifest.get("a.txt").is_some() && manifest.get("a.txt.upper").is_some(),
        "{reply}"
    );

    // Committed by the host command itself: the shell catches up, reads it, and commits its own change after.
    let reply = io.block_on(run(
        &shell,
        manifest,
        "stash hello there && cat stash.txt && echo more > b.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "hello there\n", "{reply}");
    assert!(reply.get("commit").is_none(), "{reply}");
    let changed: Vec<&str> = reply["changed"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        changed.contains(&"stash.txt") && changed.contains(&"b.txt"),
        "{reply}"
    );
    assert!(reply["manifest"].get("stash.txt").is_some(), "{reply}");

    // A name the isolate lacks is served by the host command, neither refused nor reported as needing a microVM.
    let reply = io.block_on(run(&shell, json!({}), "unzip x.zip"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "served\n", "{reply}");
    assert!(reply.get("needsMicrovm").is_none(), "{reply}");
}
