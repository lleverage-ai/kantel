//! Kantel's own guest shell over a persistent workspace (the reference provider): its commands' changes are
//! committed to the record, and a commit whose outcome is unknown or refused fails the command and says so, with the
//! files as the record holds them. Needs the guest bundle (`bun run guest/build.ts`), as the binary does.

use std::sync::Arc;
use std::time::Duration;

use kantel_isolate::isolate::spawn_shell;
use kantel_isolate::limits::Command;
use kantel_isolate::workspace::contract::subjects::manifest_of;
use kantel_isolate::workspace::memory::{Fault, RecordProvider};
use kantel_isolate::workspace::{
    BoxFuture, Capabilities, CatchUp, Commit, CommitReply, FilesystemProvider, ReadError, Staged,
    View, Workspace,
};
use kantel_isolate::{Config, Embedding, Engine};
use serde_json::{Value, json};

const GUEST: &str = include_str!("../guest/dist/guest.js");

/// The reference provider, with a commit that takes `delay` before it writes (a slow store), for a command stopped
/// while it commits.
struct Slow {
    inner: Arc<dyn Workspace>,
    delay: Duration,
}

impl Workspace for Slow {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn view(&self) -> BoxFuture<'_, anyhow::Result<View>> {
        self.inner.view()
    }
    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut kantel_isolate::bridges::Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        self.inner.read(file, cap, charge)
    }
    fn stage<'a>(&'a self, path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, anyhow::Result<Staged>> {
        self.inner.stage(path, bytes)
    }
    fn commit(&self, commit: Commit) -> BoxFuture<'_, anyhow::Result<CommitReply>> {
        Box::pin(async move {
            tokio::time::sleep(self.delay).await;
            self.inner.commit(commit).await
        })
    }
    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, anyhow::Result<CatchUp>> {
        self.inner.sync(base)
    }
}

/// The reference provider, where the host writes `path` (as a host command's outputs would) just before the
/// command's own commit, which the store then refuses if `fail`.
struct HostFirst {
    inner: Arc<dyn Workspace>,
    records: Arc<RecordProvider>,
    path: &'static str,
    fail: bool,
}

impl Workspace for HostFirst {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn view(&self) -> BoxFuture<'_, anyhow::Result<View>> {
        self.inner.view()
    }
    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut kantel_isolate::bridges::Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        self.inner.read(file, cap, charge)
    }
    fn stage<'a>(&'a self, path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, anyhow::Result<Staged>> {
        self.inner.stage(path, bytes)
    }
    fn commit(&self, commit: Commit) -> BoxFuture<'_, anyhow::Result<CommitReply>> {
        Box::pin(async move {
            let now = self.inner.view().await?;
            let staged = self.inner.stage(self.path, b"host\n".to_vec()).await?;
            let host = Commit {
                operation_id: "host".into(),
                base: now.generation,
                puts: vec![kantel_isolate::workspace::Put {
                    path: self.path.into(),
                    blob: staged.blob,
                    mode: None,
                }],
                ..Commit::default()
            };
            self.inner.commit(host).await?;
            if self.fail {
                self.records.inject("s", Fault::Fail);
            }
            self.inner.commit(commit).await
        })
    }
    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, anyhow::Result<CatchUp>> {
        self.inner.sync(base)
    }
}

async fn run(
    shell: &kantel_isolate::isolate::ShellHandle,
    workspace: Arc<dyn Workspace>,
    command: &str,
) -> Value {
    run_for(
        shell,
        workspace,
        command,
        Duration::from_secs(20),
        json!({}),
    )
    .await
}

async fn run_for(
    shell: &kantel_isolate::isolate::ShellHandle,
    workspace: Arc<dyn Workspace>,
    command: &str,
    wall: Duration,
    extra: Value,
) -> Value {
    let view = workspace.view().await.expect("view");
    let mut manifest = manifest_of(&view.entries);
    // Entries the provider doesn't list (kantel-host's manifest may have some it can't read).
    for (path, entry) in extra.as_object().unwrap() {
        manifest[path] = entry.clone();
    }
    let request = json!({ "command": command, "manifest": manifest, "base": view.generation });
    shell
        .exec(
            &request,
            manifest,
            workspace,
            Command::new(Duration::from_secs(20), wall),
        )
        .await
        .expect("exec")
}

#[test]
fn the_guest_shell_commits_to_a_persistent_workspace_and_reports_unsaved_changes() {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().unwrap();
    let records = Arc::new(RecordProvider::default());
    records.seed(
        "s",
        &[
            ("a.txt", b"alpha\n"),
            ("dir/n.txt", b"nested\n"),
            ("x", b"file\n"),
        ],
    );
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
        commit_grace: Duration::from_secs(1),
        ..Config::new(std::env::temp_dir())
    };
    let embedding = Embedding::new(GUEST).with_filesystem(records.clone());
    Engine::init(cfg, embedding, io.handle().clone(), false).unwrap();
    let shell = spawn_shell("s".into(), 256, false);
    let open = || records.open("s", &Value::Null).expect("open");

    // Committed: the shell read the record's file lazily and its write is in the record.
    let reply = io.block_on(run(&shell, open(), "cat a.txt && echo bravo > b.txt"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "alpha\n", "{reply}");
    assert!(reply.get("commit").is_none(), "{reply}");
    assert_eq!(reply["changed"], json!(["b.txt"]), "{reply}");
    assert_eq!(records.files("s")["b.txt"], b"bravo\n");
    // The reply names the workspace's own file ids (not content hashes), so a caller can read what it says.
    let id = reply["manifest"]["b.txt"]["sha"]
        .as_str()
        .unwrap()
        .to_string();
    let bytes = io
        .block_on(async { open().read(&id, usize::MAX, None).await })
        .unwrap();
    assert_eq!(bytes, b"bravo\n");

    // A files-only workspace: directories are implied by paths, so reading and writing under one commits only files.
    let reply = io.block_on(run(
        &shell,
        open(),
        "cat dir/n.txt && mkdir -p dir/sub && echo e > dir/sub/e.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(reply["stdout"], "nested\n", "{reply}");
    assert_eq!(reply["changed"], json!(["dir/sub/e.txt"]), "{reply}");
    assert_eq!(records.files("s")["dir/sub/e.txt"], b"e\n");
    // A file replaced by a directory: the file is removed, the directory implied by what's in it.
    let reply = io.block_on(run(&shell, open(), "rm x && mkdir x && echo y > x/y"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert!(reply["manifest"].get("x").is_none(), "{reply}");
    assert!(reply["manifest"].get("x/y").is_some(), "{reply}");
    assert!(!records.files("s").contains_key("x"));
    assert_eq!(records.files("s")["x/y"], b"y\n");

    // Lost reply, not landed: the command fails and says so, and its change isn't in the record or the manifest.
    records.inject("s", Fault::Unknown { landed: false });
    let reply = io.block_on(run(&shell, open(), "echo charlie > c.txt"));
    assert_eq!(reply["exitCode"], 1, "{reply}");
    assert_eq!(reply["commit"]["status"], "unknown", "{reply}");
    assert!(
        reply["stderr"]
            .as_str()
            .unwrap()
            .contains("may not have been saved"),
        "{reply}"
    );
    assert!(reply["manifest"].get("c.txt").is_none(), "{reply}");
    assert!(!records.files("s").contains_key("c.txt"));

    // Lost reply, landed: the manifest is the record's, with the change; the command still says it may not be saved.
    records.inject("s", Fault::Unknown { landed: true });
    let reply = io.block_on(run(&shell, open(), "echo delta > d.txt"));
    assert_eq!(reply["commit"]["status"], "unknown", "{reply}");
    assert!(reply["manifest"].get("d.txt").is_some(), "{reply}");
    assert_eq!(records.files("s")["d.txt"], b"delta\n");

    // Refused: nothing saved, the command fails, the manifest is unchanged.
    records.inject("s", Fault::Fail);
    let reply = io.block_on(run(&shell, open(), "rm a.txt"));
    assert_eq!(reply["exitCode"], 1, "{reply}");
    assert_eq!(reply["commit"]["status"], "failed", "{reply}");
    assert_eq!(reply["changed"], json!([]), "{reply}");
    assert!(reply["manifest"].get("a.txt").is_some(), "{reply}");
    assert!(records.files("s").contains_key("a.txt"));

    // Refused after the host wrote too: the command's change isn't saved, but the reply has the host's file.
    let host_first: Arc<dyn Workspace> = Arc::new(HostFirst {
        inner: open(),
        records: records.clone(),
        path: "host.txt",
        fail: true,
    });
    let reply = io.block_on(run(&shell, host_first, "echo mine > mine.txt"));
    assert_eq!(reply["commit"]["status"], "failed", "{reply}");
    assert!(reply["manifest"].get("host.txt").is_some(), "{reply}");
    assert!(reply["manifest"].get("mine.txt").is_none(), "{reply}");
    assert_eq!(reply["changed"], json!(["host.txt"]), "{reply}");

    // Stopped while its commit is in flight: the commit isn't cut off, and the reply says what the workspace holds
    // (here the commit landed, so the file is in it).
    let slow: Arc<dyn Workspace> = Arc::new(Slow {
        inner: open(),
        delay: Duration::from_millis(400),
    });
    let reply = io.block_on(run_for(
        &shell,
        slow,
        "rmdir empty && echo late > late.txt",
        Duration::from_millis(150),
        json!({ "empty": { "kind": "dir" } }),
    ));
    assert_eq!(reply["terminated"], "wall", "{reply}");
    assert!(reply["manifest"].get("late.txt").is_some(), "{reply}");
    // An entry the provider never listed (a files-only workspace has no directories), removed by the committed
    // command, is gone from the reply too.
    assert!(reply["manifest"].get("empty").is_none(), "{reply}");
    assert_eq!(reply["changed"], json!(["late.txt", "empty"]), "{reply}");
    assert!(reply.get("commit").is_none(), "{reply}");
    assert_eq!(records.files("s")["late.txt"], b"late\n");

    // Unchanged files aren't commits, whatever the provider's ids are: written over with the same bytes (unread, and
    // read first), nothing is committed, so a host write made since the command's base stands.
    for command in [
        "printf 'alpha\\n' > a.txt",
        "cat a.txt > /dev/null && printf 'alpha\\n' > a.txt",
    ] {
        let reply = io.block_on(run(&shell, open(), command));
        assert_eq!(reply["exitCode"], 0, "{command}: {reply}");
        assert_eq!(reply["changed"], json!([]), "{command}: {reply}");
    }
    let host_first: Arc<dyn Workspace> = Arc::new(HostFirst {
        inner: open(),
        records: records.clone(),
        path: "a.txt",
        fail: false,
    });
    let reply = io.block_on(run(
        &shell,
        host_first,
        "printf 'alpha\\n' > a.txt && echo z > z.txt",
    ));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(records.files("s")["a.txt"], b"host\n", "{reply}");
    // A real change, of bytes or of mode, still is one.
    let reply = io.block_on(run(
        &shell,
        open(),
        "printf 'new\\n' > a.txt && chmod 600 b.txt",
    ));
    assert_eq!(reply["changed"], json!(["a.txt", "b.txt"]), "{reply}");
    assert_eq!(records.files("s")["a.txt"], b"new\n");

    // The shell starts from the provider's files, whatever the request's manifest says: none sent, or a stale one,
    // a conditional default doesn't overwrite what is there.
    for manifest in [
        json!({}),
        json!({ "a.txt": { "kind": "file", "sha": "stale", "size": 1, "mode": 420 } }),
    ] {
        let body =
            json!({ "command": "test -e a.txt || echo default > a.txt", "manifest": manifest });
        let prepared = io
            .block_on(kantel_isolate::server::prepare("s", &body))
            .unwrap();
        assert!(
            prepared.request["manifest"]["a.txt"]["sha"] != "stale",
            "{}",
            prepared.request
        );
        let reply = io
            .block_on(shell.exec(
                &prepared.request,
                prepared.manifest,
                prepared.workspace,
                Command::new(Duration::from_secs(20), Duration::from_secs(20)),
            ))
            .unwrap();
        assert_eq!(reply["changed"], json!([]), "{reply}");
        assert_eq!(records.files("s")["a.txt"], b"new\n");
    }

    // A commit still running when the grace ends holds the sandbox's next command back until it ends, so it can't
    // land over that command's work.
    let slower: Arc<dyn Workspace> = Arc::new(Slow {
        inner: open(),
        delay: Duration::from_millis(5000),
    });
    let reply = io.block_on(run_for(
        &shell,
        slower,
        "echo first > order.txt",
        Duration::from_millis(100),
        json!({}),
    ));
    assert_eq!(reply["commit"]["status"], "unknown", "{reply}");
    let refused = io.block_on(run(&shell, open(), "echo second > order.txt"));
    assert_eq!(refused["retryable"], true, "{refused}");
    // Once it has landed, the next command runs, and its write is the one that stays.
    let landed = std::time::Instant::now();
    while !records.files("s").contains_key("order.txt") {
        assert!(
            landed.elapsed() < Duration::from_secs(10),
            "the slow commit never landed"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let reply = io.block_on(run(&shell, open(), "echo second > order.txt"));
    assert_eq!(reply["exitCode"], 0, "{reply}");
    assert_eq!(records.files("s")["order.txt"], b"second\n");
}
