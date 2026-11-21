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
use kantel_isolate::workspace::contract::subjects::{MemoryBlobs, manifest_of};
use kantel_isolate::workspace::memory::RecordProvider;
use kantel_isolate::workspace::{BoxFuture, FilesystemProvider, ManifestProvider, Workspace};
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

/// `put PATH TEXT`: writes TEXT to PATH (an inline output).
struct Put;
impl HostCommand for Put {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            Ok(HostReply {
                writes: vec![HostWrite::Bytes {
                    path: request.args[0].clone(),
                    bytes: format!("{}\n", request.args[1..].join(" ")).into_bytes(),
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

/// `peek FILE START LEN`: where the file's bytes are (the workspace's or the shell's), its size, that range of it,
/// and the size of the whole of it as a host read gets it.
struct Peek;
impl HostCommand for Peek {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>> {
        Box::pin(async move {
            let [path, start, len] = &request.args[..] else {
                anyhow::bail!("usage: peek FILE START LEN");
            };
            let file = request
                .files
                .file(path)
                .await?
                .ok_or_else(|| anyhow::anyhow!("{path}: no such file"))?;
            let range = request
                .files
                .read_range(path, start.parse()?, len.parse()?)
                .await?;
            let whole = request.files.read(path, 1 << 20).await?;
            let at = if file.id.is_some() {
                "workspace"
            } else {
                "shell"
            };
            Ok(HostReply {
                stdout: format!(
                    "{at} {} {} {}\n",
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

/// A command over a persistent workspace (the reference provider, whose file ids aren't content hashes).
async fn run_on(
    shell: &kantel_isolate::isolate::ShellHandle,
    workspace: Arc<dyn Workspace>,
    command: &str,
) -> Value {
    let view = workspace.view().await.expect("view");
    let manifest = manifest_of(&view.entries);
    let request = json!({ "command": command, "manifest": manifest, "base": view.generation });
    shell
        .exec(
            &request,
            manifest,
            workspace,
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
        .with_host_command("put", Arc::new(Put))
        .with_host_command("slow", Arc::new(Slow))
        .with_host_command("peek", Arc::new(Peek))
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

    // A staged output moved away is no longer kept at its old path: what is made there next is its own.
    let reply = io.block_on(run(
        &shell,
        json!({}),
        "stash hello && mv stash.txt moved.txt && mkdir stash.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["manifest"]["stash.txt"]["kind"], "dir", "{reply}");
    assert_eq!(reply["manifest"]["moved.txt"]["size"], 6, "{reply}");
    let reply = io.block_on(run(&shell, reply["manifest"].clone(), "cat moved.txt"));
    assert_eq!(reply["stdout"], "hello\n", "{reply}");

    // Symbolic links, to a file and to a directory: a host command reads through them as the shell does, and its
    // outputs land where the shell resolves them.
    let reply = io.block_on(run(
        &shell,
        json!({}),
        "echo data > data.csv && ln -s data.csv current.csv && upper current.csv && mkdir -p runs/2 && \
         echo r > runs/2/r.txt && ln -s runs/2 latest && cd latest && upper r.txt && cat r.txt.upper",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "DATA\nR\nR\n", "{reply}");
    assert_eq!(
        reply["manifest"]["runs/2/r.txt.upper"]["size"], 2,
        "{reply}"
    );
    // Into a directory not there yet, below a link: made where the link leads.
    let reply = io.block_on(run(
        &shell,
        reply["manifest"].clone(),
        "put latest/new/out.txt hi && cat runs/2/new/out.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "hi\n", "{reply}");
    assert_eq!(
        reply["manifest"]["runs/2/new/out.txt"]["size"], 3,
        "{reply}"
    );

    // An untouched file keeps its entry, special mode bits too: never read, nothing committed.
    let reply = io.block_on(run(
        &shell,
        json!({ "s.bin": { "kind": "file", "sha": "0".repeat(64), "size": 3, "mode": 0o4755 } }),
        "true",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["changed"], json!([]), "{reply}");
    assert_eq!(reply["timings"]["lazyReads"], 0, "{reply}");

    // Over a workspace whose ids aren't content hashes, a staged output that is what the file already was is no
    // change (nothing to commit over a newer write of the host's).
    let records = Arc::new(RecordProvider::default());
    records.seed("u", &[("stash.txt", b"same\n")]);
    let reply = io.block_on(run_on(
        &shell,
        records.open("u", &Value::Null).expect("open"),
        "stash same",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["changed"], json!([]), "{reply}");

    // Over a workspace whose ids aren't content hashes, a staged output over an existing file, then touched again
    // (its mode as it was), is told from the file the command started with by its bytes.
    records.seed("r", &[("stash.txt", b"old\n")]);
    let open = || records.open("r", &Value::Null).expect("open");
    let reply = io.block_on(run_on(&shell, open(), "stash hello && chmod 644 stash.txt"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["changed"], json!(["stash.txt"]), "{reply}");
    assert_eq!(reply["manifest"]["stash.txt"]["mode"], 0o644, "{reply}");
    assert_eq!(records.files("r")["stash.txt"], b"hello\n");

    // A host command reads a file larger than the guest may (the provider's isolate read cap), whole or by range,
    // and knows the workspace's id of an untouched file; one the command wrote has none, and is read from the shell.
    let capped = Arc::new(RecordProvider::new(8));
    capped.seed("c", &[("big.txt", b"0123456789abcdef")]);
    let open = || capped.open("c", &Value::Null).expect("open");
    let reply = io.block_on(run_on(&shell, open(), "peek big.txt 4 6"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "workspace 16 456789 16\n", "{reply}");
    let reply = io.block_on(run_on(&shell, open(), "cat big.txt"));
    assert_ne!(
        reply["exitCode"], 0,
        "the guest's read is still capped: {reply}"
    );
    let reply = io.block_on(run_on(
        &shell,
        open(),
        "echo hello > new.txt && peek new.txt 1 3",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "shell 6 ell 6\n", "{reply}");

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
