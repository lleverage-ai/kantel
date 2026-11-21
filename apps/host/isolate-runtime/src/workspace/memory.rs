//! The reference persistent-workspace provider, in memory: what an embedder's durable provider (a session
//! workspace bound to a record in object storage or a database) does, small enough to read in one go, with faults
//! to inject. [`contract`](super::contract) runs against it.
//!
//! Each sandbox has one record: its files (path → blob) and a generation that every write moves on, written by
//! compare-and-swap against the generation the writer holds and only while the writer owns the record. A sandbox's
//! workspace is kept between commands. A command's commit is one record write:
//!
//! - written: `committed`;
//! - refused before anything was written ([`Fault::Fail`]): `failed`, and the changes stand;
//! - outcome lost ([`Fault::Unknown`], landed or not): `unknown`, with the record as read back, and never replayed;
//! - the record moved on under another owner ([`RecordProvider::take_over`]) or a stale base: `fenced`, for good.
//!
//! It keeps files only (directories are implied by paths, as in a record of blobs), and reads at most
//! [`RecordProvider::new`]'s `read_cap` bytes into an isolate; reads for the host (`host_read`, `read_range`) aren't
//! held to it.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use serde_json::Value;

use super::{
    BoxFuture, Capabilities, CatchUp, Commit, CommitReply, FilesystemProvider, Node, Put,
    ReadError, Staged, View, Workspace, apply, check_paths, diff, range_of,
};
use crate::bridges::Charge;

/// A fault the next record write meets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// The store refuses the write: nothing is written.
    Fail,
    /// The write's reply is lost; it `landed` or not.
    Unknown { landed: bool },
}

struct Record {
    generation: u64,
    files: BTreeMap<String, Node>,
    owner: u64,
}

struct Shared {
    record: Mutex<Record>,
    blobs: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    faults: Mutex<VecDeque<Fault>>,
    /// Another writer writes the record after the next write whose reply is lost.
    move_on: AtomicBool,
    next_blob: AtomicU64,
}

/// A sandbox's record and its current owner's workspace.
type Sandbox = (Arc<Shared>, Arc<RecordWorkspace>);

/// The reference persistent provider: one record per sandbox, one workspace per sandbox per owner.
pub struct RecordProvider {
    sandboxes: Mutex<HashMap<String, Sandbox>>,
    owners: AtomicU64,
    read_cap: usize,
}

impl Default for RecordProvider {
    fn default() -> Self {
        RecordProvider::new(usize::MAX)
    }
}

impl RecordProvider {
    /// A provider whose reads into an isolate stop at `read_cap` bytes (`ReadError::TooLarge` past it), beside the
    /// reader's own cap.
    pub fn new(read_cap: usize) -> RecordProvider {
        RecordProvider {
            sandboxes: Mutex::new(HashMap::new()),
            owners: AtomicU64::new(1),
            read_cap,
        }
    }

    fn shared(&self, sandbox_id: &str) -> Arc<Shared> {
        self.entry(sandbox_id).0
    }

    fn entry(&self, sandbox_id: &str) -> Sandbox {
        let mut sandboxes = self.sandboxes.lock().unwrap();
        sandboxes
            .entry(sandbox_id.to_string())
            .or_insert_with(|| {
                let owner = self.owners.fetch_add(1, Ordering::SeqCst);
                let shared = Arc::new(Shared {
                    record: Mutex::new(Record {
                        generation: 1,
                        files: BTreeMap::new(),
                        owner,
                    }),
                    blobs: Mutex::new(HashMap::new()),
                    faults: Mutex::new(VecDeque::new()),
                    move_on: AtomicBool::new(false),
                    next_blob: AtomicU64::new(1),
                });
                let workspace = RecordWorkspace::new(shared.clone(), owner, self.read_cap);
                (shared, workspace)
            })
            .clone()
    }

    /// Put files in a sandbox's record before its first command (as a restore would).
    pub fn seed(&self, sandbox_id: &str, files: &[(&str, &[u8])]) {
        let shared = self.shared(sandbox_id);
        let mut record = shared.record.lock().unwrap();
        for (path, bytes) in files {
            let blob = shared.new_blob(bytes.to_vec());
            record.files.insert(
                path.to_string(),
                Node::file(blob, bytes.len() as u64, 0o644),
            );
        }
        record.generation += 1;
    }

    /// The next record write of this sandbox meets `fault`.
    pub fn inject(&self, sandbox_id: &str, fault: Fault) {
        self.shared(sandbox_id)
            .faults
            .lock()
            .unwrap()
            .push_back(fault);
    }

    /// Another writer that isn't a new owner (the platform, say) writes the sandbox's record right after the
    /// sandbox's next record write whose reply is lost ([`Fault::Unknown`]), before the workspace reads the record
    /// back: the record has moved on, by a file of that writer's (`moved-on.txt`).
    pub fn move_on_after_lost_reply(&self, sandbox_id: &str) {
        self.shared(sandbox_id)
            .move_on
            .store(true, Ordering::SeqCst);
    }

    /// Another owner takes the sandbox's record over (as another replica re-acquiring the session would) and writes
    /// to it: the workspace this provider gave is fenced. A later `open` gives the new owner's workspace.
    pub fn take_over(&self, sandbox_id: &str) {
        let shared = self.shared(sandbox_id);
        let owner = self.owners.fetch_add(1, Ordering::SeqCst);
        {
            let mut record = shared.record.lock().unwrap();
            record.owner = owner;
            record.generation += 1;
        }
        let workspace = RecordWorkspace::new(shared.clone(), owner, self.read_cap);
        self.sandboxes
            .lock()
            .unwrap()
            .insert(sandbox_id.to_string(), (shared, workspace));
    }

    /// The record's files now, by path, with their bytes.
    pub fn files(&self, sandbox_id: &str) -> BTreeMap<String, Vec<u8>> {
        let shared = self.shared(sandbox_id);
        let record = shared.record.lock().unwrap();
        let blobs = shared.blobs.lock().unwrap();
        record
            .files
            .iter()
            .filter_map(|(path, node)| match node {
                Node::File { file, .. } => blobs
                    .get(file)
                    .map(|bytes| (path.clone(), bytes.as_ref().clone())),
                _ => None,
            })
            .collect()
    }
}

impl FilesystemProvider for RecordProvider {
    fn open(&self, sandbox_id: &str, _request: &Value) -> Result<Arc<dyn Workspace>> {
        Ok(self.entry(sandbox_id).1)
    }
}

impl Shared {
    fn new_blob(&self, bytes: Vec<u8>) -> String {
        let id = format!("blob-{}", self.next_blob.fetch_add(1, Ordering::SeqCst));
        self.blobs
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(bytes));
        id
    }
}

fn generation(n: u64) -> String {
    format!("g{n}")
}

struct Held {
    /// Versions given to the guest (by views and catch-ups), oldest first, with their files. The last is the
    /// record's generation as this workspace last wrote or read it.
    versions: Vec<(String, BTreeMap<String, Node>)>,
    /// Blobs staged here, and their sizes.
    staged: HashMap<String, u64>,
    /// Set for good when another owner has the record or the guest named a version this workspace never gave.
    fenced: Option<String>,
}

/// A sandbox's workspace under one owner of its record.
pub struct RecordWorkspace {
    shared: Arc<Shared>,
    owner: u64,
    read_cap: usize,
    held: Mutex<Held>,
}

impl RecordWorkspace {
    fn new(shared: Arc<Shared>, owner: u64, read_cap: usize) -> Arc<RecordWorkspace> {
        let (generation_now, files) = {
            let record = shared.record.lock().unwrap();
            (generation(record.generation), record.files.clone())
        };
        Arc::new(RecordWorkspace {
            shared,
            owner,
            read_cap,
            held: Mutex::new(Held {
                versions: vec![(generation_now, files)],
                staged: HashMap::new(),
                fenced: None,
            }),
        })
    }

    fn remember(held: &mut Held, generation: String, files: BTreeMap<String, Node>) {
        if held.versions.last().map(|(g, _)| g) != Some(&generation) {
            held.versions.push((generation, files));
        }
    }

    fn fence(held: &mut Held, error: String) -> CommitReply {
        held.fenced = Some(error.clone());
        CommitReply::Fenced { error }
    }

    /// The bytes of a file this workspace gave (a view's or a staged one), if they are at most `cap`.
    fn given(&self, file: &str, cap: usize) -> Result<Arc<Vec<u8>>, ReadError> {
        let size = {
            let held = self.held.lock().unwrap();
            let given = held
                .versions
                .iter()
                .flat_map(|(_, files)| files.values())
                .find_map(|node| match node {
                    Node::File { file: f, size, .. } if f == file => Some(*size),
                    _ => None,
                });
            match given.or_else(|| held.staged.get(file).copied()) {
                Some(size) => size,
                None => return Err(ReadError::NotFound),
            }
        };
        if size > cap as u64 {
            return Err(ReadError::TooLarge {
                size,
                cap: cap as u64,
            });
        }
        self.shared
            .blobs
            .lock()
            .unwrap()
            .get(file)
            .cloned()
            .ok_or(ReadError::NotFound)
    }
}

impl Workspace for RecordWorkspace {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            directories: false,
            symlinks: false,
            content_addressed: false,
        }
    }

    fn view(&self) -> BoxFuture<'_, Result<View>> {
        Box::pin(async move {
            let mut held = self.held.lock().unwrap();
            if let Some(error) = &held.fenced {
                bail!("{error}");
            }
            let record = self.shared.record.lock().unwrap();
            if record.owner != self.owner {
                drop(record);
                let error = "another owner has this workspace's record".to_string();
                held.fenced = Some(error.clone());
                bail!("{error}");
            }
            let view = View {
                generation: generation(record.generation),
                entries: record.files.clone(),
            };
            drop(record);
            Self::remember(&mut held, view.generation.clone(), view.entries.clone());
            Ok(view)
        })
    }

    fn read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
        charge: Option<&'a mut Charge>,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async move {
            let bytes = self.given(file, cap.min(self.read_cap))?;
            if let Some(charge) = charge {
                charge
                    .add(bytes.len())
                    .map_err(|e| ReadError::Failed(e.to_string()))?;
            }
            Ok(bytes.as_ref().clone())
        })
    }

    /// Not held to the provider's `read_cap`, which is for reads into an isolate.
    fn host_read<'a>(
        &'a self,
        file: &'a str,
        cap: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async move { Ok(self.given(file, cap)?.as_ref().clone()) })
    }

    fn read_range<'a>(
        &'a self,
        file: &'a str,
        start: u64,
        len: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async move {
            let bytes = self.given(file, usize::MAX)?;
            Ok(range_of(&bytes, start, len).to_vec())
        })
    }

    fn stage<'a>(&'a self, _path: &'a str, bytes: Vec<u8>) -> BoxFuture<'a, Result<Staged>> {
        Box::pin(async move {
            if let Some(error) = &self.held.lock().unwrap().fenced {
                bail!("{error}");
            }
            let size = bytes.len() as u64;
            let blob = self.shared.new_blob(bytes);
            self.held.lock().unwrap().staged.insert(blob.clone(), size);
            Ok(Staged {
                blob,
                size,
                hash: None,
            })
        })
    }

    fn commit(&self, commit: Commit) -> BoxFuture<'_, Result<CommitReply>> {
        Box::pin(async move {
            let mut held = self.held.lock().unwrap();
            if let Some(error) = &held.fenced {
                return Ok(CommitReply::Fenced {
                    error: error.clone(),
                });
            }
            let Some(base_files) = held
                .versions
                .iter()
                .find(|(g, _)| *g == commit.base)
                .map(|(_, files)| files.clone())
            else {
                return Ok(Self::fence(
                    &mut held,
                    format!("{} isn't a version this workspace gave", commit.base),
                ));
            };
            let (held_generation, held_files) = held
                .versions
                .last()
                .cloned()
                .expect("a record workspace has a version");
            let failed = |error: String| CommitReply::Failed {
                error,
                catch_up: diff(&commit.base, &base_files, &held_generation, &held_files),
            };
            if let Err(e) = check_paths(&commit) {
                return Ok(failed(e));
            }
            if !commit.links.is_empty() || !commit.dirs.is_empty() {
                return Ok(failed(
                    "this workspace keeps files only (no symlinks or directories)".into(),
                ));
            }
            if let Some(put) = commit
                .puts
                .iter()
                .find(|put| !held.staged.contains_key(&put.blob))
            {
                return Ok(failed(format!("{}: no such staged blob", put.path)));
            }
            let fault = self.shared.faults.lock().unwrap().pop_front();
            let mut record = self.shared.record.lock().unwrap();
            // The compare-and-swap: only the owner, only over the generation it holds.
            if record.owner != self.owner || generation(record.generation) != held_generation {
                drop(record);
                return Ok(Self::fence(
                    &mut held,
                    "another owner wrote this workspace's record".into(),
                ));
            }
            let staged = &held.staged;
            let file = |put: &Put| {
                Node::file(
                    put.blob.clone(),
                    staged.get(&put.blob).copied().unwrap_or(0),
                    put.mode.unwrap_or(0o644) & 0o7777,
                )
            };
            let write = |record: &mut Record| {
                record.files = apply(&record.files, &commit, file);
                record.generation += 1;
            };
            let reply = match fault {
                Some(Fault::Fail) => return Ok(failed("the store refused the write".into())),
                Some(Fault::Unknown { landed }) => {
                    if landed {
                        write(&mut record);
                    }
                    if self.shared.move_on.swap(false, Ordering::SeqCst) {
                        let bytes = b"another writer's\n".to_vec();
                        let size = bytes.len() as u64;
                        let blob = self.shared.new_blob(bytes);
                        record
                            .files
                            .insert("moved-on.txt".into(), Node::file(blob, size, 0o644));
                        record.generation += 1;
                    }
                    // Read back: what the record holds is what the guest takes.
                    let now = generation(record.generation);
                    CommitReply::Unknown {
                        error: "the write's outcome is unknown (its reply was lost)".into(),
                        catch_up: diff(&commit.base, &base_files, &now, &record.files),
                    }
                }
                None => {
                    write(&mut record);
                    let now = generation(record.generation);
                    CommitReply::Committed {
                        catch_up: diff(&commit.base, &base_files, &now, &record.files),
                    }
                }
            };
            let (now, files) = (generation(record.generation), record.files.clone());
            drop(record);
            Self::remember(&mut held, now, files);
            Ok(reply)
        })
    }

    fn sync<'a>(&'a self, base: &'a str) -> BoxFuture<'a, Result<CatchUp>> {
        Box::pin(async move {
            let held = self.held.lock().unwrap();
            if let Some(error) = &held.fenced {
                bail!("{error}");
            }
            let Some((_, from)) = held.versions.iter().find(|(g, _)| g == base) else {
                bail!("{base} isn't a version this workspace gave");
            };
            let (now, files) = held.versions.last().expect("a version");
            Ok(diff(base, from, now, files))
        })
    }
}
