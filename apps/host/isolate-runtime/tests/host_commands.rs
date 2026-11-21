//! The embedder's host commands, run by Kantel's own guest shell: they read the shell's files as they are (one the
//! command just wrote included), hand back small outputs inline and large ones staged (which the shell commits by
//! their blob, without reading them), stop when the shell's `timeout` cancels them, and a name the isolate otherwise
//! lacks is served, not refused. Needs the guest bundle (`bun run guest/build.ts`), as the binary does.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use kantel_isolate::host_commands::{HostCommand, HostReply, HostRequest, HostWrite};
use kantel_isolate::isolate::spawn_shell;
use kantel_isolate::limits::Command;
use kantel_isolate::workspace::contract::subjects::MemoryBlobs;
use kantel_isolate::workspace::{BoxFuture, ManifestProvider};
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
                writes: vec![HostWrite::Bytes {
                    path: format!("{name}.upper"),
                    bytes,
                    mode: None,
                }],
                ..Default::default()
            })
        })
    }
}

/// `stash TEXT`: stages stash.txt through the workspace and answers it staged (a large output's way).
struct Stash;
impl HostCommand for Stash {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            let text = format!("{}\n", request.args.join(" "));
            let staged = request.files.stage("stash.txt", text.into_bytes()).await?;
            Ok(HostReply {
                writes: vec![HostWrite::Staged {
                    path: "stash.txt".into(),
                    staged,
                    mode: None,
                }],
                ..Default::default()
            })
        })
    }
}

/// `slow`: takes ten seconds, unless it is cancelled.
struct Slow;
impl HostCommand for Slow {
    fn run<'a>(&'a self, _request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(HostReply::default())
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
        .with_host_command("slow", Arc::new(Slow))
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

    // A staged output the command doesn't read: committed by its blob, never read into the isolate.
    let reply = io.block_on(run(
        &shell,
        manifest,
        "stash hello there && echo more > b.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["timings"]["lazyReads"], 0, "{reply}");
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
    let manifest = reply["manifest"].clone();
    assert_eq!(manifest["stash.txt"]["size"], 12, "{reply}");
    // The next command reads it like any other file.
    let reply = io.block_on(run(&shell, manifest, "cat stash.txt"));
    assert_eq!(reply["stdout"], "hello there\n", "{reply}");

    // The shell's `timeout` cancels a host command on the host too.
    let started = Instant::now();
    let reply = io.block_on(run(&shell, json!({}), "timeout 0.2 slow; echo after"));
    assert_eq!(reply["stdout"], "after\n", "{reply}");
    assert!(started.elapsed() < Duration::from_secs(5), "{reply}");

    // A name the isolate lacks is served by the host command, neither refused nor reported as needing a microVM.
    let reply = io.block_on(run(&shell, json!({}), "unzip x.zip"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "served\n", "{reply}");
    assert!(reply.get("needsMicrovm").is_none(), "{reply}");
}
