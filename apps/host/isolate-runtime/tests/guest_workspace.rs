//! Kantel's own guest shell over a persistent workspace (the reference provider): its commands' changes are
//! committed to the record, and a commit whose outcome is unknown or refused fails the command and says so, with the
//! files as the record holds them. Needs the guest bundle (`bun run guest/build.ts`), as the binary does.

use std::sync::Arc;
use std::time::Duration;

use kantel_isolate::isolate::spawn_shell;
use kantel_isolate::limits::Command;
use kantel_isolate::workspace::contract::subjects::manifest_of;
use kantel_isolate::workspace::memory::{Fault, RecordProvider};
use kantel_isolate::workspace::{FilesystemProvider, Workspace};
use kantel_isolate::{Config, Embedding, Engine};
use serde_json::{Value, json};

const GUEST: &str = include_str!("../guest/dist/guest.js");

async fn run(
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
fn the_guest_shell_commits_to_a_persistent_workspace_and_reports_unsaved_changes() {
    kantel_isolate::init_v8();
    let io = tokio::runtime::Runtime::new().unwrap();
    let records = Arc::new(RecordProvider::default());
    records.seed("s", &[("a.txt", b"alpha\n")]);
    let cfg = Config {
        pool: 0,
        node_pool: 0,
        python_pool: 0,
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
}
