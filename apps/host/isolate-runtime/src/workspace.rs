//! The filesystem provider: where a sandbox's files come from, and where a command's changes go.
//!
//! The guest's shell keeps its own filesystem for a command (Kantel's is just-bash's in-memory one, built from the
//! view); the provider is what that filesystem reads from and commits to. One interface serves two models:
//!
//! - **A manifest per command** (Kantel, [`ManifestProvider`]): the host sends the sandbox's files with each command
//!   and keeps what the command returns. The view is that manifest, a commit makes the next one, and nothing can
//!   race it, so a commit is always `committed` (or refused outright).
//! - **A persistent workspace** (an embedder's, such as a session workspace bound to a durable record): the provider
//!   keeps the files between commands, and each command's changes are one compare-and-swap commit to the record. A
//!   write whose outcome isn't known (it timed out, the connection dropped) is reported as `unknown`, with the
//!   record's state, and never replayed; another owner taking the record over fences the workspace.
//!   [`memory::RecordProvider`] is the reference provider of this kind.
//!
//! The exchange, per command:
//!
//! 1. [`FilesystemProvider::open`] gives the command's [`Workspace`], and [`Workspace::view`] its starting [`View`]:
//!    every path, and the opaque generation the view is of.
//! 2. The guest reads files by id ([`Workspace::read`]), only ones a view it was given or [`Workspace::stage`] named.
//! 3. At the end it stages each changed file's bytes ([`Workspace::stage`]) and sends one [`Commit`]: the base it
//!    started from and its changes. The [`CommitReply`] carries a [`CatchUp`] from that base to what the workspace
//!    now holds, whatever the outcome short of `fenced`.
//! 4. After the host itself changed the workspace (a host command's outputs), [`Workspace::sync`] catches the
//!    guest's base up.
//!
//! [`contract`] holds the tests every provider passes, so an embedder runs them against its own.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bridges::Charge;

pub mod contract;
pub mod manifest;
pub mod memory;

pub use manifest::{BlobStore, ManifestProvider};

/// A boxed future, as the provider traits return (they're used as trait objects).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What is at a path. A file is named by an opaque id the provider gave (Kantel's: its SHA-256).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    File {
        file: String,
        size: u64,
        mode: u32,
        /// Last modified, in milliseconds since the epoch, where the provider keeps it.
        #[serde(default, rename = "mtimeMs", skip_serializing_if = "Option::is_none")]
        mtime_ms: Option<u64>,
        /// A content hash the provider caches the bytes by, where it has one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hash: Option<String>,
    },
    Dir,
    Symlink {
        target: String,
    },
}

impl Node {
    /// A file with no modification time or hash.
    pub fn file(file: impl Into<String>, size: u64, mode: u32) -> Node {
        Node::File {
            file: file.into(),
            size,
            mode,
            mtime_ms: None,
            hash: None,
        }
    }
}

/// A version of the workspace, as a command starts from it. Paths are relative to the workspace root, without a
/// leading slash; a directory is listed only where the provider keeps directories.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct View {
    pub generation: String,
    pub entries: BTreeMap<String, Node>,
}

/// Why a read gave no bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// No file with this id in a view the workspace gave, nor staged in it.
    NotFound,
    /// Larger than the reader may take (`cap`, the isolate's memory or the provider's own read cap). Refused before
    /// the bytes are read.
    TooLarge {
        size: u64,
        cap: u64,
    },
    Failed(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::NotFound => f.write_str("not in this sandbox's files"),
            ReadError::TooLarge { size, cap } => write!(
                f,
                "file too large ({size} bytes; the isolate reads at most {cap})"
            ),
            ReadError::Failed(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for ReadError {}

/// A file's bytes, uploaded for a commit to name. Nothing refers to it until a commit does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Staged {
    pub blob: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Put {
    pub path: String,
    /// A blob [`Workspace::stage`] gave this workspace.
    pub blob: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub path: String,
    pub target: String,
}

/// One command's changes, made from the version `base`. Applied whole or not at all: removals first, then
/// directories, links and files, each replacing what was at its path.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// The guest's, for the provider's records and to tell its commits apart.
    pub operation_id: String,
    pub base: String,
    #[serde(default)]
    pub puts: Vec<Put>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub dirs: Vec<String>,
    #[serde(default)]
    pub removes: Vec<String>,
}

/// The workspace's changes from version `from` to `generation`: what a guest whose base is `from` applies to have
/// `generation`'s files.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatchUp {
    pub from: String,
    pub generation: String,
    pub changed: BTreeMap<String, Node>,
    pub removed: Vec<String>,
}

/// How a commit ended. Every reply that leaves the workspace usable carries a catch-up from the commit's base.
///
/// - `committed`: the changes are in `catchUp.generation`.
/// - `unknown`: the write may or may not have landed. The catch-up is what the workspace holds now, read back after
///   the write; the guest takes it and drops the changes it sent, and nothing replays them.
/// - `failed`: nothing was written; the guest's changes still stand, and it may send them again.
/// - `fenced`: the workspace takes no more commits (another owner has its record, or a base it never gave was named).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CommitReply {
    Committed {
        #[serde(rename = "catchUp")]
        catch_up: CatchUp,
    },
    Unknown {
        error: String,
        #[serde(rename = "catchUp")]
        catch_up: CatchUp,
    },
    Failed {
        error: String,
        #[serde(rename = "catchUp")]
        catch_up: CatchUp,
    },
    Fenced {
        error: String,
    },
}

impl CommitReply {
    pub fn status(&self) -> &'static str {
        match self {
            CommitReply::Committed { .. } => "committed",
            CommitReply::Unknown { .. } => "unknown",
            CommitReply::Failed { .. } => "failed",
            CommitReply::Fenced { .. } => "fenced",
        }
    }
}

/// What a workspace can hold besides files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub directories: bool,
    pub symlinks: bool,
}

/// One sandbox's files for a command (see the module docs for the exchange). Used from the isolate's ops on the
/// engine's I/O runtime: every method may be called concurrently.
pub trait Workspace: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    /// The version a command starts from.
    fn view(&self) -> BoxFuture<'_, Result<View>>;

    /// A file's bytes, by the id a view or [`stage`](Self::stage) gave. At most `cap` bytes: a larger file is
    /// [`ReadError::TooLarge`], refused before it is read. `charge`, when given, is charged as the bytes arrive (the
    /// isolate's memory budget), so a read can't bring in more than the isolate may hold.
    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>>;

    /// Upload a file's bytes for a commit to name.
    fn stage<'a>(&'a self, path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, Result<Staged>>;

    /// Apply one command's changes (see [`Commit`] and [`CommitReply`]). An `Err` is a fault of the provider itself
    /// (the guest reports it as the command's); protocol outcomes are replies.
    fn commit(&self, commit: Commit) -> BoxFuture<'_, Result<CommitReply>>;

    /// The changes from version `base`, which the guest holds, to the workspace's current one. An error if `base`
    /// isn't a version this workspace gave.
    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, Result<CatchUp>>;
}

/// Where sandboxes' files come from: the embedder's, given in the [`Embedding`](crate::Embedding).
pub trait FilesystemProvider: Send + Sync {
    /// The workspace one command in `sandbox_id` runs against. `request` is the embedder's input for the command
    /// (Kantel's: the /exec body, whose `manifest` is the sandbox's files). A per-command provider makes a new one; a
    /// persistent one gives the sandbox's own.
    fn open(&self, sandbox_id: &str, request: &Value) -> Result<Arc<dyn Workspace>>;
}

/// `entries` with a commit's changes applied (removals, then directories, links and files). For providers that keep
/// their files as a [`View`]'s map; `blob` gives each put's node (its size and mode).
pub fn apply(
    entries: &BTreeMap<String, Node>,
    commit: &Commit,
    mut file: impl FnMut(&Put) -> Node,
) -> BTreeMap<String, Node> {
    let mut next = entries.clone();
    for path in &commit.removes {
        next.remove(path);
    }
    for path in &commit.dirs {
        next.insert(path.clone(), Node::Dir);
    }
    for link in &commit.links {
        next.insert(
            link.path.clone(),
            Node::Symlink {
                target: link.target.clone(),
            },
        );
    }
    for put in &commit.puts {
        next.insert(put.path.clone(), file(put));
    }
    next
}

/// The catch-up from `before` (version `from`) to `after` (version `generation`).
pub fn diff(
    from: &str,
    before: &BTreeMap<String, Node>,
    generation: &str,
    after: &BTreeMap<String, Node>,
) -> CatchUp {
    let changed = after
        .iter()
        .filter(|(path, node)| before.get(*path) != Some(node))
        .map(|(path, node)| (path.clone(), node.clone()))
        .collect();
    let removed = before
        .keys()
        .filter(|path| !after.contains_key(*path))
        .cloned()
        .collect();
    CatchUp {
        from: from.to_string(),
        generation: generation.to_string(),
        changed,
        removed,
    }
}

/// Checks a commit's paths: relative, normalised, no `.`/`..`, no empty component. A provider refuses a commit
/// that fails it (`failed`), so a guest can't write outside the workspace by naming a path.
pub fn check_paths(commit: &Commit) -> std::result::Result<(), String> {
    let paths = commit
        .puts
        .iter()
        .map(|p| &p.path)
        .chain(commit.links.iter().map(|l| &l.path))
        .chain(commit.dirs.iter())
        .chain(commit.removes.iter());
    let mut seen = BTreeSet::new();
    for path in paths {
        if path.is_empty()
            || path.starts_with('/')
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!("{path:?} isn't a path in the workspace"));
        }
        // A path named twice (other than a removal followed by a replacement) is ambiguous.
        if !commit.removes.contains(path) && !seen.insert(path.clone()) {
            return Err(format!("{path:?} is changed twice in one commit"));
        }
    }
    Ok(())
}
