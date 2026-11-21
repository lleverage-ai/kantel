//! The filesystem provider contract (src/workspace/contract.rs) against both kinds of provider: Kantel's manifest per
//! command, and the reference persistent workspace with compare-and-swap commits and unknown outcomes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use kantel_isolate::bridges::Charge;
use kantel_isolate::workspace::contract::{self, Persistent, Resolution, Subject, subjects};
use kantel_isolate::workspace::memory::RecordProvider;
use kantel_isolate::workspace::{
    BoxFuture, Capabilities, CatchUp, Commit, CommitReply, FilesystemProvider, Node, ReadError,
    Staged, View, Workspace,
};
use serde_json::Value;

#[tokio::test]
async fn the_manifest_provider_keeps_the_contract() {
    contract::common(&subjects::Manifest::default()).await;
}

#[tokio::test]
async fn the_reference_persistent_provider_keeps_the_contract() {
    let subject = subjects::Record::default();
    contract::common(&subject).await;
    contract::persistent(&subject).await;
}

/// A host read isn't held to the cap a provider keeps for reads into an isolate; the guest's read of the same file
/// still is.
#[tokio::test]
async fn host_reads_are_not_held_to_the_isolate_read_cap() {
    let provider = RecordProvider::new(4);
    provider.seed("s", &[("big.txt", b"0123456789")]);
    let ws = provider.open("s", &Value::Null).expect("open");
    let id = match ws.view().await.expect("view").entries.get("big.txt") {
        Some(Node::File { file, .. }) => file.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        ws.read(&id, usize::MAX, None).await,
        Err(ReadError::TooLarge { size: 10, cap: 4 }),
        "the guest's read"
    );
    assert_eq!(
        ws.host_read(&id, 64).await.expect("host read"),
        b"0123456789"
    );
    assert_eq!(
        ws.host_read(&id, 9).await,
        Err(ReadError::TooLarge { size: 10, cap: 9 }),
        "the host's own cap"
    );
    assert_eq!(ws.read_range(&id, 6, 8).await.expect("range"), b"6789");
}

/// A provider that resolves a lost reply by reading the record back keeps the contract answering `committed`; one
/// that answers `committed` when the record moved on meanwhile (it can't have told) doesn't.
#[test]
fn a_provider_that_reads_lost_replies_back_may_answer_committed() {
    let check = |careless: bool| {
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let subject = ReadingBack::new(careless);
                contract::common(&subject).await;
                contract::persistent(&subject).await;
                subject.resolved.lock().unwrap().len()
            })
        })
        .join()
    };
    let resolved =
        check(false).expect("a provider that reads lost replies back keeps the contract");
    assert_eq!(resolved, 2, "both lost replies were resolved as committed");
    let failure = check(true).expect_err("answering committed over a record that moved on");
    let message = failure
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(message.contains("moved on"), "{message}");
}

/// Over the reference provider, a provider that tells what a write whose reply was lost did, as one that finds its
/// operation in the record it reads back would: it knows unless another writer moved the record on meanwhile
/// (`careless` thinks it knows then too).
struct ReadingBack {
    inner: subjects::Record,
    careless: bool,
    /// By sandbox: the next lost reply's write landed, or not, and the provider can tell which.
    told: Arc<Mutex<HashMap<String, bool>>>,
    /// The sandboxes whose lost reply it answered as committed.
    resolved: Arc<Mutex<Vec<String>>>,
}

impl ReadingBack {
    fn new(careless: bool) -> ReadingBack {
        ReadingBack {
            inner: subjects::Record::default(),
            careless,
            told: Arc::default(),
            resolved: Arc::default(),
        }
    }

    fn wrap(&self, sandbox: &str, inner: Arc<dyn Workspace>) -> Arc<dyn Workspace> {
        Arc::new(ReadingBackWorkspace {
            inner,
            sandbox: sandbox.to_string(),
            told: self.told.clone(),
            resolved: self.resolved.clone(),
        })
    }
}

impl Subject for ReadingBack {
    fn sandbox<'a>(
        &'a self,
        files: &'a [(&'a str, &'a [u8])],
    ) -> BoxFuture<'a, (String, Arc<dyn Workspace>)> {
        Box::pin(async move {
            let (id, ws) = self.inner.sandbox(files).await;
            let ws = self.wrap(&id, ws);
            (id, ws)
        })
    }
    fn next<'a>(&'a self, sandbox: &'a str, view: &'a View) -> BoxFuture<'a, Arc<dyn Workspace>> {
        Box::pin(async move { self.wrap(sandbox, self.inner.next(sandbox, view).await) })
    }
}

impl Persistent for ReadingBack {
    fn fail_next_write(&self, sandbox: &str) {
        self.inner.fail_next_write(sandbox);
    }
    fn lose_next_reply(&self, sandbox: &str, landed: bool) {
        self.inner.lose_next_reply(sandbox, landed);
        self.told.lock().unwrap().insert(sandbox.into(), landed);
    }
    fn take_over(&self, sandbox: &str) {
        self.inner.take_over(sandbox);
    }
    fn lost_reply_resolution(&self) -> Resolution {
        Resolution::ReadBack
    }
    fn lose_next_reply_and_move_on(&self, sandbox: &str, landed: bool) -> bool {
        self.inner.lose_next_reply_and_move_on(sandbox, landed);
        if self.careless {
            self.told.lock().unwrap().insert(sandbox.into(), landed);
        }
        true
    }
}

struct ReadingBackWorkspace {
    inner: Arc<dyn Workspace>,
    sandbox: String,
    told: Arc<Mutex<HashMap<String, bool>>>,
    resolved: Arc<Mutex<Vec<String>>>,
}

impl Workspace for ReadingBackWorkspace {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn view(&self) -> BoxFuture<'_, Result<View>> {
        self.inner.view()
    }
    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        self.inner.read(file, cap, charge)
    }
    fn stage<'a>(&'a self, path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, Result<Staged>> {
        self.inner.stage(path, bytes)
    }
    fn commit(&self, commit: Commit) -> BoxFuture<'_, Result<CommitReply>> {
        Box::pin(async move {
            let reply = self.inner.commit(commit.clone()).await?;
            let CommitReply::Unknown { catch_up, .. } = &reply else {
                return Ok(reply);
            };
            let Some(landed) = self.told.lock().unwrap().remove(&self.sandbox) else {
                return Ok(reply);
            };
            self.resolved.lock().unwrap().push(self.sandbox.clone());
            if landed {
                return Ok(CommitReply::Committed {
                    catch_up: catch_up.clone(),
                });
            }
            // It didn't land and nothing else wrote: sent again, once, from the same base.
            self.inner.commit(commit).await
        })
    }
    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, Result<CatchUp>> {
        self.inner.sync(base)
    }
}
