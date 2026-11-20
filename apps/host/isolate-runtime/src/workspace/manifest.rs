//! Kantel's provider: a manifest per command. kantel-host sends the sandbox's files with each /exec (path →
//! `{kind:"file", sha, size, mode}` | `{kind:"symlink", target}` | `{kind:"dir"}`), file bodies live in its blob store
//! by SHA-256, and the next manifest goes back in the reply. The view is the manifest; a commit makes the next one.
//! Only this command can change it, so a commit is `committed`, or `fenced` if it names a base other than this
//! manifest.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde_json::Value;
use sha2::Digest;

use super::{
    BoxFuture, Capabilities, CatchUp, Commit, CommitReply, FilesystemProvider, Node, ReadError,
    Staged, View, Workspace, apply, check_paths, diff,
};
use crate::bridges::{Charge, Store, valid_sha};

/// A content-addressed blob store: bodies by SHA-256. kantel-host's store bridge ([`Store`]) is one.
pub trait BlobStore: Send + Sync {
    /// A blob's bytes, at most `cap`, charged to `charge` as they arrive.
    fn get<'a>(
        &'a self,
        sha: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>>>;
    /// Store `bytes`, answering their SHA-256.
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<String>>;
}

impl BlobStore for Store {
    fn get<'a>(
        &'a self,
        sha: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(Store::get(self, sha, cap, charge))
    }
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<String>> {
        Box::pin(Store::put(self, bytes))
    }
}

/// Kantel's [`FilesystemProvider`]: each command's workspace is the manifest in its request (`request.manifest`).
pub struct ManifestProvider {
    store: Arc<dyn BlobStore>,
}

impl ManifestProvider {
    pub fn new(store: Arc<dyn BlobStore>) -> ManifestProvider {
        ManifestProvider { store }
    }
}

impl FilesystemProvider for ManifestProvider {
    fn open(&self, _sandbox_id: &str, request: &Value) -> Result<Arc<dyn Workspace>> {
        let entries = parse_manifest(request.get("manifest").unwrap_or(&Value::Null));
        Ok(Arc::new(ManifestWorkspace::new(
            self.store.clone(),
            entries,
        )))
    }
}

/// A manifest's entries. Lenient, as the guest is: an entry it can't read (a file without a valid SHA-256, an unknown
/// kind) isn't in the view, so its body can't be read through the workspace.
pub fn parse_manifest(manifest: &Value) -> BTreeMap<String, Node> {
    let mut entries = BTreeMap::new();
    let Some(obj) = manifest.as_object() else {
        return entries;
    };
    for (path, entry) in obj {
        let node = match entry.get("kind").and_then(Value::as_str) {
            Some("file") => match entry.get("sha").and_then(Value::as_str) {
                Some(sha) if valid_sha(sha) => Node::file(
                    sha,
                    entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                    entry
                        .get("mode")
                        .and_then(Value::as_u64)
                        .map(|m| m as u32 & 0o7777)
                        .unwrap_or(0o644),
                ),
                _ => continue,
            },
            Some("dir") => Node::Dir,
            Some("symlink") => match entry.get("target").and_then(Value::as_str) {
                Some(target) => Node::Symlink {
                    target: target.to_string(),
                },
                None => continue,
            },
            _ => continue,
        };
        entries.insert(path.clone(), node);
    }
    entries
}

/// A node as a manifest entry.
pub fn entry_of(node: &Node) -> Value {
    match node {
        Node::File {
            file, size, mode, ..
        } => serde_json::json!({ "kind": "file", "sha": file, "size": size, "mode": mode }),
        Node::Dir => serde_json::json!({ "kind": "dir" }),
        Node::Symlink { target } => serde_json::json!({ "kind": "symlink", "target": target }),
    }
}

/// A view's entries as a manifest.
pub fn manifest_of(entries: &BTreeMap<String, Node>) -> Value {
    Value::Object(
        entries
            .iter()
            .map(|(path, node)| (path.clone(), entry_of(node)))
            .collect(),
    )
}

/// `manifest` with a catch-up applied (removed paths dropped, changed ones replaced), and the paths it changed.
pub fn apply_catch_up(manifest: &Value, catch_up: &CatchUp) -> (Value, Vec<String>) {
    let mut files = manifest.as_object().cloned().unwrap_or_default();
    for path in &catch_up.removed {
        files.remove(path);
    }
    for (path, node) in &catch_up.changed {
        files.insert(path.clone(), entry_of(node));
    }
    let changed = catch_up
        .changed
        .keys()
        .chain(catch_up.removed.iter())
        .cloned()
        .collect();
    (Value::Object(files), changed)
}

/// The generation of a manifest: a digest of its entries, so the same files are the same version.
fn generation(entries: &BTreeMap<String, Node>) -> String {
    let canonical = serde_json::to_vec(entries).unwrap_or_default();
    format!("m-{}", hex::encode(sha2::Sha256::digest(&canonical)))
}

struct State {
    /// The versions this workspace gave, oldest first, each with its entries.
    versions: Vec<(String, BTreeMap<String, Node>)>,
    /// Blobs the command may read: its manifest's, every later version's and ones it staged.
    readable: HashSet<String>,
    /// Sizes of blobs staged here.
    staged: HashMap<String, u64>,
    /// Set for good once a commit named a base this workspace never gave.
    fenced: Option<String>,
}

impl State {
    fn current(&self) -> &(String, BTreeMap<String, Node>) {
        // Never empty: new() puts the request's manifest first.
        self.versions
            .last()
            .expect("a manifest workspace has a version")
    }
    fn version(&self, generation: &str) -> Option<&BTreeMap<String, Node>> {
        self.versions
            .iter()
            .find(|(g, _)| g == generation)
            .map(|(_, e)| e)
    }
}

/// One command's manifest (see the module docs).
pub struct ManifestWorkspace {
    store: Arc<dyn BlobStore>,
    state: Mutex<State>,
}

fn file_ids(entries: &BTreeMap<String, Node>) -> impl Iterator<Item = (&String, u64)> {
    entries.values().filter_map(|node| match node {
        Node::File { file, size, .. } => Some((file, *size)),
        _ => None,
    })
}

impl ManifestWorkspace {
    pub fn new(store: Arc<dyn BlobStore>, entries: BTreeMap<String, Node>) -> ManifestWorkspace {
        let readable = file_ids(&entries).map(|(f, _)| f.clone()).collect();
        ManifestWorkspace {
            store,
            state: Mutex::new(State {
                versions: vec![(generation(&entries), entries)],
                readable,
                staged: HashMap::new(),
                fenced: None,
            }),
        }
    }

    /// The size this workspace knows a readable blob has.
    fn known_size(state: &State, file: &str) -> Option<u64> {
        if let Some(size) = state.staged.get(file) {
            return Some(*size);
        }
        state
            .versions
            .iter()
            .flat_map(|(_, entries)| file_ids(entries))
            .find(|(f, _)| f.as_str() == file)
            .map(|(_, size)| size)
    }
}

impl Workspace for ManifestWorkspace {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            directories: true,
            symlinks: true,
        }
    }

    fn view(&self) -> BoxFuture<'_, Result<View>> {
        let (generation, entries) = self.state.lock().unwrap().current().clone();
        Box::pin(async move {
            Ok(View {
                generation,
                entries,
            })
        })
    }

    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async move {
            let size = {
                let state = self.state.lock().unwrap();
                if !state.readable.contains(file) {
                    return Err(ReadError::NotFound);
                }
                Self::known_size(&state, file)
            };
            if let Some(size) = size.filter(|s| *s > cap as u64) {
                return Err(ReadError::TooLarge {
                    size,
                    cap: cap as u64,
                });
            }
            self.store
                .get(file, cap, charge)
                .await
                .map_err(|e| ReadError::Failed(e.to_string()))
        })
    }

    fn stage<'a>(&'a self, _path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, Result<Staged>> {
        Box::pin(async move {
            let size = bytes.len() as u64;
            let sha = self.store.put(bytes).await?;
            let mut state = self.state.lock().unwrap();
            state.readable.insert(sha.clone());
            state.staged.insert(sha.clone(), size);
            Ok(Staged {
                blob: sha.clone(),
                size,
                hash: Some(sha),
            })
        })
    }

    fn commit(&self, commit: Commit) -> BoxFuture<'_, Result<CommitReply>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            if let Some(error) = &state.fenced {
                return Ok(CommitReply::Fenced {
                    error: error.clone(),
                });
            }
            let (current, entries) = state.current().clone();
            if commit.base != current {
                let error = format!(
                    "the command's changes are from {}, not this sandbox's manifest",
                    commit.base
                );
                state.fenced = Some(error.clone());
                return Ok(CommitReply::Fenced { error });
            }
            let failed = |error: String| CommitReply::Failed {
                error,
                catch_up: diff(&current, &entries, &current, &entries),
            };
            if let Err(e) = check_paths(&commit) {
                return Ok(failed(e));
            }
            // A put names a blob this command staged, or one of its manifest's (content-addressed, so the same bytes).
            let mut sizes = HashMap::new();
            for put in &commit.puts {
                match Self::known_size(&state, &put.blob) {
                    Some(size) => {
                        sizes.insert(put.blob.clone(), size);
                    }
                    None => return Ok(failed(format!("{}: no such staged blob", put.path))),
                }
            }
            let next = apply(&entries, &commit, |put| {
                Node::file(
                    put.blob.clone(),
                    sizes.get(&put.blob).copied().unwrap_or(0),
                    put.mode.unwrap_or(0o644) & 0o7777,
                )
            });
            let next_generation = generation(&next);
            let catch_up = diff(&current, &entries, &next_generation, &next);
            if next_generation != current {
                state.versions.push((next_generation, next));
            }
            Ok(CommitReply::Committed { catch_up })
        })
    }

    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, Result<CatchUp>> {
        Box::pin(async move {
            let state = self.state.lock().unwrap();
            let Some(from) = state.version(base) else {
                anyhow::bail!("{base} isn't a version this sandbox's manifest had");
            };
            let (current, entries) = state.current();
            Ok(diff(base, from, current, entries))
        })
    }
}
