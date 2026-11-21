//! The filesystem provider contract, as tests: what every [`Workspace`] does ([`common`]), and what a persistent one
//! does when a record write fails, is lost, or another owner takes over ([`persistent`]). They run here against
//! Kantel's [`ManifestProvider`](super::ManifestProvider) and the reference [`RecordProvider`](super::memory::RecordProvider)
//! (`tests/workspace_contract.rs`); an embedder runs them against its own provider by implementing [`Subject`] (and
//! [`Persistent`]). Each check panics with what it found.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::{BoxFuture, CatchUp, Commit, CommitReply, Link, Node, Put, ReadError, View, Workspace};

/// A provider under test.
pub trait Subject: Sync {
    /// A new sandbox holding `files` (path → bytes), and the workspace of its first command.
    fn sandbox<'a>(
        &'a self,
        files: &'a [(&'a str, &'a [u8])],
    ) -> BoxFuture<'a, (String, Arc<dyn Workspace>)>;

    /// The workspace of the sandbox's next command, `view` being what its last command left (a per-command provider
    /// sends it as the next request; a persistent one has it already).
    fn next<'a>(&'a self, sandbox: &'a str, view: &'a View) -> BoxFuture<'a, Arc<dyn Workspace>>;
}

/// A persistent provider under test: its record writes can be made to fail or lose their reply, and another owner
/// can take a sandbox over.
pub trait Persistent: Subject {
    /// The sandbox's next record write is refused, writing nothing.
    fn fail_next_write(&self, sandbox: &str);
    /// The sandbox's next record write loses its reply, having `landed` or not.
    fn lose_next_reply(&self, sandbox: &str, landed: bool);
    /// Another owner takes the sandbox's record over and writes to it.
    fn take_over(&self, sandbox: &str);
}

/// Every check that holds for any provider.
pub async fn common(subject: &dyn Subject) {
    views_list_files_and_reads_get_their_bytes(subject).await;
    a_read_is_refused_past_the_cap_and_for_files_not_given(subject).await;
    a_commit_puts_replaces_and_removes(subject).await;
    an_empty_commit_changes_nothing(subject).await;
    a_commit_from_a_base_never_given_is_fenced(subject).await;
    a_bad_commit_writes_nothing(subject).await;
    sync_catches_a_base_up(subject).await;
    links_and_directories_follow_the_capabilities(subject).await;
}

/// Every check for a persistent provider (after [`common`]).
pub async fn persistent(subject: &dyn Persistent) {
    a_refused_write_leaves_the_changes_standing(subject).await;
    a_lost_reply_is_unknown_with_the_record_as_it_is(subject, true).await;
    a_lost_reply_is_unknown_with_the_record_as_it_is(subject, false).await;
    a_base_behind_the_record_commits_and_catches_up(subject).await;
    another_owner_fences_the_workspace(subject).await;
}

const A: &[u8] = b"alpha\n";
const B: &[u8] = b"bravo bravo\n";

fn file_of(view: &View, path: &str) -> String {
    match view.entries.get(path) {
        Some(Node::File { file, .. }) => file.clone(),
        other => panic!("{path}: expected a file in the view, found {other:?}"),
    }
}

async fn read_all(ws: &Arc<dyn Workspace>, file: &str) -> Vec<u8> {
    ws.read(file, usize::MAX, None)
        .await
        .unwrap_or_else(|e| panic!("read {file}: {e}"))
}

async fn put(ws: &Arc<dyn Workspace>, path: &str, bytes: &[u8]) -> Put {
    let staged = ws
        .stage(path, bytes.to_vec())
        .await
        .unwrap_or_else(|e| panic!("stage {path}: {e:#}"));
    assert_eq!(staged.size, bytes.len() as u64, "staged size of {path}");
    Put {
        path: path.into(),
        blob: staged.blob,
        mode: None,
    }
}

/// A commit with an operation id of its own (a provider may tell operations apart by it).
fn commit(base: &str, puts: Vec<Put>, removes: &[&str]) -> Commit {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    Commit {
        operation_id: format!(
            "contract-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        base: base.into(),
        puts,
        removes: removes.iter().map(|s| s.to_string()).collect(),
        ..Commit::default()
    }
}

fn committed(reply: CommitReply) -> CatchUp {
    match reply {
        CommitReply::Committed { catch_up } => catch_up,
        other => panic!("expected committed, got {other:?}"),
    }
}

async fn views_list_files_and_reads_get_their_bytes(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A), ("dir/b.txt", B)]).await;
    let view = ws.view().await.expect("view");
    assert!(!view.generation.is_empty(), "a view has a generation");
    match view.entries.get("dir/b.txt") {
        Some(Node::File { size, .. }) => assert_eq!(*size, B.len() as u64, "dir/b.txt's size"),
        other => panic!("dir/b.txt: {other:?}"),
    }
    assert_eq!(read_all(&ws, &file_of(&view, "a.txt")).await, A);
    assert_eq!(read_all(&ws, &file_of(&view, "dir/b.txt")).await, B);
    // A content-addressed provider's ids are the bytes' SHA-256, which a guest relies on to tell unchanged files.
    if ws.capabilities().content_addressed {
        use sha2::Digest;
        assert_eq!(
            file_of(&view, "a.txt"),
            hex::encode(sha2::Sha256::digest(A))
        );
    }
}

async fn a_read_is_refused_past_the_cap_and_for_files_not_given(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("b.txt", B)]).await;
    let view = ws.view().await.expect("view");
    let b = file_of(&view, "b.txt");
    match ws.read(&b, B.len() - 1, None).await {
        Err(ReadError::TooLarge { size, cap }) => {
            assert_eq!((size, cap), (B.len() as u64, B.len() as u64 - 1))
        }
        other => panic!("a read past the cap: {other:?}"),
    }
    // Exactly at the cap is allowed.
    assert_eq!(ws.read(&b, B.len(), None).await.expect("at the cap"), B);
    // A file id no view or staging gave this workspace (another sandbox's file, or made up).
    let (_, other) = s.sandbox(&[("secret.txt", b"another sandbox's\n")]).await;
    let theirs = file_of(&other.view().await.expect("view"), "secret.txt");
    for id in [
        theirs.as_str(),
        "0000000000000000000000000000000000000000000000000000000000000000",
    ] {
        if id == b {
            continue;
        }
        assert_eq!(
            ws.read(id, usize::MAX, None).await,
            Err(ReadError::NotFound),
            "reading {id}, which this workspace never named"
        );
    }
}

async fn a_commit_puts_replaces_and_removes(s: &dyn Subject) {
    let (id, ws) = s
        .sandbox(&[("keep.txt", A), ("old.txt", A), ("gone.txt", B)])
        .await;
    let base = ws.view().await.expect("view");
    let puts = vec![put(&ws, "new/c.txt", B).await, put(&ws, "old.txt", B).await];
    let catch_up = committed(
        ws.commit(commit(&base.generation, puts, &["gone.txt"]))
            .await
            .expect("commit"),
    );
    assert_eq!(
        catch_up.from, base.generation,
        "a catch-up starts at the commit's base"
    );
    assert_ne!(
        catch_up.generation, base.generation,
        "a commit that changes files makes a new version"
    );
    assert_eq!(catch_up.removed, vec!["gone.txt".to_string()]);
    let changed: Vec<&str> = catch_up.changed.keys().map(String::as_str).collect();
    assert!(
        changed.contains(&"new/c.txt")
            && changed.contains(&"old.txt")
            && !changed.contains(&"keep.txt"),
        "changed {changed:?}"
    );
    // The next command sees the committed files, and reads the new bytes.
    let next = ws.view().await.expect("view after commit");
    assert_eq!(next.generation, catch_up.generation);
    let ws = s.next(&id, &next).await;
    let view = ws.view().await.expect("next command's view");
    assert!(
        !view.entries.contains_key("gone.txt"),
        "a removed file is gone"
    );
    assert_eq!(
        read_all(&ws, &file_of(&view, "old.txt")).await,
        B,
        "a replaced file has its new bytes"
    );
    assert_eq!(read_all(&ws, &file_of(&view, "new/c.txt")).await, B);
    assert_eq!(read_all(&ws, &file_of(&view, "keep.txt")).await, A);
}

async fn an_empty_commit_changes_nothing(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let catch_up = committed(
        ws.commit(commit(&base.generation, vec![], &[]))
            .await
            .expect("commit"),
    );
    assert!(
        catch_up.changed.is_empty() && catch_up.removed.is_empty(),
        "{catch_up:?}"
    );
    assert_eq!(ws.view().await.expect("view").entries, base.entries);
}

async fn a_commit_from_a_base_never_given_is_fenced(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let p = put(&ws, "x.txt", B).await;
    // Staged before the fence: a fenced workspace may refuse to stage too.
    let later = put(&ws, "y.txt", B).await;
    let reply = ws
        .commit(commit("not-a-version", vec![p], &[]))
        .await
        .expect("commit");
    assert!(matches!(reply, CommitReply::Fenced { .. }), "{reply:?}");
    // Nothing was written: the files are as they were (a fenced persistent workspace refuses a view, which says so).
    if let Ok(view) = ws.view().await {
        assert_eq!(view.entries, base.entries, "a fenced commit wrote nothing");
    }
    // Fenced is for good: a commit from the base it did give is refused too.
    let reply = ws
        .commit(commit(&base.generation, vec![later], &[]))
        .await
        .expect("commit");
    assert!(
        matches!(reply, CommitReply::Fenced { .. }),
        "a fenced workspace committed: {reply:?}"
    )
}

async fn a_bad_commit_writes_nothing(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let good = put(&ws, "ok.txt", B).await;
    let bad_commits = [
        // A blob nobody staged.
        Commit {
            puts: vec![Put {
                path: "x.txt".into(),
                blob: "never-staged".into(),
                mode: None,
            }],
            ..commit(&base.generation, vec![], &[])
        },
        // Paths outside the workspace, or not normalised.
        commit(
            &base.generation,
            vec![Put {
                path: "../escape".into(),
                ..good.clone()
            }],
            &[],
        ),
        commit(
            &base.generation,
            vec![Put {
                path: "/abs".into(),
                ..good.clone()
            }],
            &[],
        ),
        commit(
            &base.generation,
            vec![Put {
                path: "a//b".into(),
                ..good.clone()
            }],
            &[],
        ),
        // One path changed twice, removed or not.
        commit(&base.generation, vec![good.clone(), good.clone()], &[]),
        commit(
            &base.generation,
            vec![good.clone(), good.clone()],
            &["ok.txt"],
        ),
    ];
    for bad in bad_commits {
        match ws.commit(bad.clone()).await.expect("commit") {
            CommitReply::Failed { catch_up, .. } => {
                assert_eq!(catch_up.from, base.generation, "{bad:?}");
                assert!(
                    catch_up.changed.is_empty() && catch_up.removed.is_empty(),
                    "{bad:?}: {catch_up:?}"
                );
            }
            other => panic!("{bad:?}: expected failed, got {other:?}"),
        }
    }
    assert_eq!(
        ws.view().await.expect("view").entries,
        base.entries,
        "a refused commit wrote nothing"
    );
    // The good change still commits.
    committed(
        ws.commit(commit(&base.generation, vec![good], &[]))
            .await
            .expect("commit"),
    );
}

async fn sync_catches_a_base_up(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let none = ws
        .sync(&base.generation)
        .await
        .expect("sync at the current version");
    assert_eq!(
        (none.from.as_str(), none.generation.as_str()),
        (base.generation.as_str(), base.generation.as_str())
    );
    assert!(none.changed.is_empty() && none.removed.is_empty());
    let p = put(&ws, "b.txt", B).await;
    let catch_up = committed(
        ws.commit(commit(&base.generation, vec![p], &["a.txt"]))
            .await
            .expect("commit"),
    );
    let synced = ws
        .sync(&base.generation)
        .await
        .expect("sync from the old base");
    assert_eq!(
        synced, catch_up,
        "sync from a base gives the same catch-up as the commit did"
    );
    assert!(
        ws.sync("not-a-version").await.is_err(),
        "sync from a version never given is an error"
    );
}

async fn links_and_directories_follow_the_capabilities(s: &dyn Subject) {
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let caps = ws.capabilities();
    let with_link = Commit {
        links: vec![Link {
            path: "l".into(),
            target: "a.txt".into(),
        }],
        ..commit(&base.generation, vec![], &[])
    };
    let with_dir = Commit {
        dirs: vec!["d".into()],
        ..commit(&base.generation, vec![], &[])
    };
    for (supported, c, path, node) in [
        (
            caps.symlinks,
            with_link,
            "l",
            Node::Symlink {
                target: "a.txt".into(),
            },
        ),
        (caps.directories, with_dir, "d", Node::Dir),
    ] {
        let base = ws.view().await.expect("view");
        let c = Commit {
            base: base.generation.clone(),
            ..c
        };
        match (supported, ws.commit(c).await.expect("commit")) {
            (true, CommitReply::Committed { catch_up }) => {
                assert_eq!(catch_up.changed.get(path), Some(&node))
            }
            (false, CommitReply::Failed { .. }) => {
                assert_eq!(ws.view().await.expect("view").entries, base.entries)
            }
            (supported, reply) => panic!("{path} (supported: {supported}): {reply:?}"),
        }
    }
}

async fn a_refused_write_leaves_the_changes_standing(s: &dyn Persistent) {
    let (id, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let p = put(&ws, "b.txt", B).await;
    s.fail_next_write(&id);
    match ws
        .commit(commit(&base.generation, vec![p.clone()], &[]))
        .await
        .expect("commit")
    {
        CommitReply::Failed { catch_up, .. } => {
            assert_eq!(catch_up.from, base.generation);
            assert!(
                catch_up.changed.is_empty() && catch_up.removed.is_empty(),
                "{catch_up:?}"
            );
        }
        other => panic!("a refused write: {other:?}"),
    }
    assert_eq!(
        ws.view().await.expect("view").entries,
        base.entries,
        "a refused write wrote nothing"
    );
    // The guest's changes stand, so it sends them again, and they commit.
    let catch_up = committed(
        ws.commit(commit(&base.generation, vec![p], &[]))
            .await
            .expect("retry"),
    );
    assert!(catch_up.changed.contains_key("b.txt"));
}

async fn a_lost_reply_is_unknown_with_the_record_as_it_is(s: &dyn Persistent, landed: bool) {
    let (id, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let p = put(&ws, "b.txt", B).await;
    s.lose_next_reply(&id, landed);
    let catch_up = match ws
        .commit(commit(&base.generation, vec![p], &["a.txt"]))
        .await
        .expect("commit")
    {
        CommitReply::Unknown { error, catch_up } => {
            assert!(!error.is_empty());
            catch_up
        }
        other => panic!("a lost reply (landed: {landed}): {other:?}"),
    };
    // The catch-up is the record as it is: with the change if it landed, without it if not. Never half.
    assert_eq!(catch_up.from, base.generation);
    assert_eq!(
        catch_up.changed.contains_key("b.txt"),
        landed,
        "{catch_up:?}"
    );
    assert_eq!(
        catch_up.removed.contains(&"a.txt".to_string()),
        landed,
        "{catch_up:?}"
    );
    let now = ws.view().await.expect("view");
    assert_eq!(
        now.generation, catch_up.generation,
        "the catch-up is to the record's version"
    );
    assert_eq!(now.entries.contains_key("b.txt"), landed);
    // Nothing replays it: the guest dropped its change, and the next commit is from the catch-up's version.
    let c = put(&ws, "c.txt", A).await;
    let next = committed(
        ws.commit(commit(&catch_up.generation, vec![c], &[]))
            .await
            .expect("commit"),
    );
    let view = ws.view().await.expect("view");
    assert_eq!(view.generation, next.generation);
    assert_eq!(
        view.entries.contains_key("b.txt"),
        landed,
        "an unknown commit was replayed"
    );
}

async fn a_base_behind_the_record_commits_and_catches_up(s: &dyn Persistent) {
    // A guest whose base is behind (the host committed a host command's outputs since) commits over the record as
    // it is, and its catch-up has both changes.
    let (_, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let host = put(&ws, "host.txt", B).await;
    committed(
        ws.commit(commit(&base.generation, vec![host], &[]))
            .await
            .expect("host commit"),
    );
    let guest = put(&ws, "guest.txt", A).await;
    let catch_up = committed(
        ws.commit(commit(&base.generation, vec![guest], &[]))
            .await
            .expect("guest commit"),
    );
    assert!(
        catch_up.changed.contains_key("host.txt") && catch_up.changed.contains_key("guest.txt"),
        "{catch_up:?}"
    );
}

async fn another_owner_fences_the_workspace(s: &dyn Persistent) {
    let (id, ws) = s.sandbox(&[("a.txt", A)]).await;
    let base = ws.view().await.expect("view");
    let p = put(&ws, "b.txt", B).await;
    s.take_over(&id);
    for attempt in 0..2 {
        let reply = ws
            .commit(commit(&base.generation, vec![p.clone()], &[]))
            .await
            .expect("commit");
        assert!(
            matches!(reply, CommitReply::Fenced { .. }),
            "attempt {attempt}: {reply:?}"
        );
    }
    assert!(ws.view().await.is_err(), "a fenced workspace gives no view");
    // The new owner's workspace works, without the fenced change.
    let fresh = s.next(&id, &base).await;
    let view = fresh.view().await.expect("the new owner's view");
    assert!(!view.entries.contains_key("b.txt"));
    let p = put(&fresh, "b.txt", B).await;
    committed(
        fresh
            .commit(commit(&view.generation, vec![p], &[]))
            .await
            .expect("commit"),
    );
}

/// A [`Subject`] over Kantel's manifest provider and an in-memory blob store, for this crate's tests.
pub mod subjects {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use anyhow::{Result, anyhow};
    use serde_json::{Value, json};
    use sha2::Digest;

    use super::*;
    use crate::bridges::Charge;
    use crate::workspace::memory::{Fault, RecordProvider};
    use crate::workspace::{BlobStore, FilesystemProvider, ManifestProvider};

    /// Blobs by SHA-256, in memory.
    #[derive(Default)]
    pub struct MemoryBlobs(Mutex<HashMap<String, Vec<u8>>>);

    impl BlobStore for MemoryBlobs {
        fn get<'a>(
            &'a self,
            sha: &'a str,
            cap: usize,
            _charge: Option<&'a mut Charge>,
        ) -> BoxFuture<'a, Result<Vec<u8>>> {
            Box::pin(async move {
                let bytes = self
                    .0
                    .lock()
                    .unwrap()
                    .get(sha)
                    .cloned()
                    .ok_or_else(|| anyhow!("blob {sha}: 404"))?;
                if bytes.len() > cap {
                    return Err(anyhow!("blob {sha}: larger than {cap}"));
                }
                Ok(bytes)
            })
        }
        fn put(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<String>> {
            Box::pin(async move {
                let sha = hex::encode(sha2::Sha256::digest(&bytes));
                self.0.lock().unwrap().insert(sha.clone(), bytes);
                Ok(sha)
            })
        }
    }

    /// Kantel's provider: each command's workspace is opened from the manifest the last one left.
    pub struct Manifest {
        pub blobs: Arc<MemoryBlobs>,
        provider: ManifestProvider,
        sandboxes: AtomicU64,
    }

    impl Default for Manifest {
        fn default() -> Self {
            let blobs = Arc::new(MemoryBlobs::default());
            Manifest {
                provider: ManifestProvider::new(blobs.clone()),
                blobs,
                sandboxes: AtomicU64::new(0),
            }
        }
    }

    /// A view as kantel-host's manifest.
    pub use crate::workspace::manifest::manifest_of;

    impl Subject for Manifest {
        fn sandbox<'a>(
            &'a self,
            files: &'a [(&'a str, &'a [u8])],
        ) -> BoxFuture<'a, (String, Arc<dyn Workspace>)> {
            Box::pin(async move {
                let mut entries = BTreeMap::new();
                for (path, bytes) in files {
                    let sha = self.blobs.put(bytes.to_vec()).await.expect("put");
                    entries.insert(path.to_string(), Node::file(sha, bytes.len() as u64, 0o644));
                }
                let id = format!("sandbox-{}", self.sandboxes.fetch_add(1, Ordering::SeqCst));
                let ws = self
                    .provider
                    .open(&id, &json!({ "manifest": manifest_of(&entries) }))
                    .expect("open");
                (id, ws)
            })
        }
        fn next<'a>(
            &'a self,
            sandbox: &'a str,
            view: &'a View,
        ) -> BoxFuture<'a, Arc<dyn Workspace>> {
            Box::pin(async move {
                self.provider
                    .open(sandbox, &json!({ "manifest": manifest_of(&view.entries) }))
                    .expect("open")
            })
        }
    }

    /// The reference persistent provider.
    #[derive(Default)]
    pub struct Record {
        pub provider: RecordProvider,
        sandboxes: AtomicU64,
    }

    impl Subject for Record {
        fn sandbox<'a>(
            &'a self,
            files: &'a [(&'a str, &'a [u8])],
        ) -> BoxFuture<'a, (String, Arc<dyn Workspace>)> {
            Box::pin(async move {
                let id = format!("sandbox-{}", self.sandboxes.fetch_add(1, Ordering::SeqCst));
                self.provider.seed(&id, files);
                let ws = self.provider.open(&id, &Value::Null).expect("open");
                (id, ws)
            })
        }
        fn next<'a>(
            &'a self,
            sandbox: &'a str,
            _view: &'a View,
        ) -> BoxFuture<'a, Arc<dyn Workspace>> {
            Box::pin(async move { self.provider.open(sandbox, &Value::Null).expect("open") })
        }
    }

    impl Persistent for Record {
        fn fail_next_write(&self, sandbox: &str) {
            self.provider.inject(sandbox, Fault::Fail);
        }
        fn lose_next_reply(&self, sandbox: &str, landed: bool) {
            self.provider.inject(sandbox, Fault::Unknown { landed });
        }
        fn take_over(&self, sandbox: &str) {
            self.provider.take_over(sandbox);
        }
    }
}
