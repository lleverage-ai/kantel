//! Host commands: programs the embedder runs natively on the host for the guest's shell (an SQL engine over a large
//! file, a search tool, an archive reader), instead of in the isolate, so their bytes never enter the isolate's heap.
//! The embedder registers them in its [`Embedding`](crate::Embedding) by name; the guest shell defines a command for
//! each (`op_kt_host_commands`), and running one calls [`HostCommand::run`] on the engine's I/O runtime
//! (`op_kt_host_command`), bounded by the shell command's deadline and dropped (cancelled) if the command is stopped.
//!
//! A host command gets its arguments, working directory, environment and stdin, and the shell's files as they are at
//! that moment ([`HostFiles`]: an untouched file is read through the command's workspace, one the command changed
//! comes inline). It answers its exit code, stdout and stderr, and the files it changes, in either of two ways:
//!
//! - small outputs inline in [`HostReply::writes`] and [`HostReply::removes`]: the shell applies them to its files, and
//!   they are committed with the rest of the command's changes;
//! - large outputs committed by the host command itself through the workspace ([`HostFiles::workspace`]: stage, then
//!   commit from the workspace's current version), with [`HostReply::workspace_changed`] set: the shell then catches
//!   its files up with the workspace (`op_kt_sync`), and the outputs never pass through the isolate.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::workspace::{BoxFuture, Workspace};

/// One host command, registered under a name. `run` may be called for several sandboxes at once.
pub trait HostCommand: Send + Sync {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>>;
}

/// The host commands an embedder registers, by the name the shell runs them under.
pub type HostCommands = BTreeMap<String, Arc<dyn HostCommand>>;

/// One run of a host command.
pub struct HostRequest {
    pub sandbox_id: Arc<str>,
    pub name: String,
    pub args: Vec<String>,
    /// The shell's working directory (absolute, under `/workspace`).
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub stdin: Vec<u8>,
    /// When the shell command it is part of must end; the run is dropped then if it hasn't.
    pub deadline: Instant,
    pub files: HostFiles,
}

/// A file as the shell's index names it.
#[derive(Clone, Debug)]
enum Indexed {
    /// Untouched by the command: read through the workspace by id.
    Workspace { file: String, size: u64 },
    /// Changed by the command: its bytes, inline.
    Inline(usize, usize),
}

/// The shell's files at the moment the host command runs, by path relative to `/workspace`.
pub struct HostFiles {
    files: HashMap<String, Indexed>,
    dirs: Vec<String>,
    payload: Arc<Vec<u8>>,
    workspace: Option<Arc<dyn Workspace>>,
}

impl HostFiles {
    /// The files' paths (directories not included).
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    /// Whether `path` is a directory in the shell's files.
    pub fn is_dir(&self, path: &str) -> bool {
        self.dirs.iter().any(|d| d == path)
    }

    /// A file's size, if it is one.
    pub fn size(&self, path: &str) -> Option<u64> {
        match self.files.get(path)? {
            Indexed::Workspace { size, .. } => Some(*size),
            Indexed::Inline(_, len) => Some(*len as u64),
        }
    }

    /// A file's bytes, at most `cap`. A path relative to `/workspace`, or an absolute one under it.
    pub async fn read(&self, path: &str, cap: usize) -> Result<Vec<u8>> {
        let path = path
            .strip_prefix("/workspace/")
            .unwrap_or(path)
            .trim_start_matches('/');
        match self.files.get(path) {
            None => bail!("{path}: no such file"),
            Some(Indexed::Inline(off, len)) => {
                if *len > cap {
                    bail!("{path}: file too large ({len} bytes; at most {cap})");
                }
                self.payload
                    .get(*off..off + len)
                    .map(<[u8]>::to_vec)
                    .ok_or_else(|| anyhow!("{path}: bad inline file"))
            }
            Some(Indexed::Workspace { file, .. }) => {
                let workspace = self
                    .workspace
                    .as_ref()
                    .ok_or_else(|| anyhow!("{path}: no workspace to read it from"))?;
                workspace
                    .read(file, cap, None)
                    .await
                    .map_err(|e| anyhow!("{path}: {e}"))
            }
        }
    }

    /// The shell command's workspace, for a host command that commits its own outputs (see the module docs).
    pub fn workspace(&self) -> Option<&Arc<dyn Workspace>> {
        self.workspace.as_ref()
    }
}

/// What a host command answers.
#[derive(Default)]
pub struct HostReply {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Files to write (path relative to `/workspace`, bytes, mode), applied by the shell.
    pub writes: Vec<(String, Vec<u8>, Option<u32>)>,
    /// Paths to remove, applied by the shell before the writes.
    pub removes: Vec<String>,
    /// The host command committed changes through the workspace itself: the shell catches its files up.
    pub workspace_changed: bool,
}

/// The request the guest sends (`meta`, with `[offset, length]` slices of `payload`), as a [`HostRequest`].
pub(crate) fn request(
    sandbox_id: Arc<str>,
    deadline: Instant,
    workspace: Option<Arc<dyn Workspace>>,
    meta: &Value,
    payload: Vec<u8>,
) -> Result<HostRequest> {
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let slice = |v: &Value| -> Option<(usize, usize)> {
        let a = v.as_array()?;
        let off = a.first()?.as_u64()? as usize;
        let len = a.get(1)?.as_u64()? as usize;
        (off.checked_add(len)? <= payload.len()).then_some((off, len))
    };
    let mut files = HashMap::new();
    let mut dirs = Vec::new();
    for (path, entry) in meta["index"].as_object().into_iter().flatten() {
        match entry["kind"].as_str() {
            Some("dir") => dirs.push(path.clone()),
            Some("file") => {
                if let Some(file) = entry["sha"].as_str() {
                    let size = entry["size"].as_u64().unwrap_or(0);
                    files.insert(
                        path.clone(),
                        Indexed::Workspace {
                            file: file.to_string(),
                            size,
                        },
                    );
                } else if let Some((off, len)) = slice(&entry["data"]) {
                    files.insert(path.clone(), Indexed::Inline(off, len));
                }
            }
            _ => {}
        }
    }
    let stdin = slice(&meta["stdin"])
        .map(|(off, len)| payload[off..off + len].to_vec())
        .unwrap_or_default();
    let env = meta["env"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
        .collect();
    Ok(HostRequest {
        sandbox_id,
        name: meta["name"].as_str().unwrap_or_default().to_string(),
        args: strings(&meta["args"]),
        cwd: meta["cwd"].as_str().unwrap_or("/workspace").to_string(),
        env,
        stdin,
        deadline,
        files: HostFiles {
            files,
            dirs,
            payload: Arc::new(payload),
            workspace,
        },
    })
}

/// A reply as the guest reads it: meta with `[offset, length]` slices of the data after it (bridges::pack's format,
/// as a node/python run's).
pub(crate) fn pack_reply(reply: &HostReply) -> Vec<u8> {
    let mut data = Vec::new();
    let mut add = |bytes: &[u8]| {
        let at = json!([data.len(), bytes.len()]);
        data.extend_from_slice(bytes);
        at
    };
    let stdout = add(&reply.stdout);
    let stderr = add(&reply.stderr);
    let writes: Vec<Value> = reply
        .writes
        .iter()
        .map(|(path, bytes, mode)| {
            let mut write = json!({ "path": path, "data": add(bytes) });
            if let Some(mode) = mode {
                write["mode"] = json!(mode);
            }
            write
        })
        .collect();
    let meta = json!({
        "exitCode": reply.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "writes": writes,
        "removes": reply.removes,
        "workspaceChanged": reply.workspace_changed,
    });
    crate::bridges::pack(&meta, &data)
}
