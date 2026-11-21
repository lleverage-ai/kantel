//! Host commands: programs the embedder runs natively on the host for the guest's shell (an SQL engine over a large
//! file, a search tool, an archive reader), instead of in the isolate, so their bytes never enter the isolate's heap.
//! The embedder registers them in its [`Embedding`](crate::Embedding) by name; the guest shell defines a command for
//! each (`op_kt_host_commands`), and running one calls [`HostCommand::run`] on the engine's I/O runtime
//! (`op_kt_host_command`), until the shell command's deadline, and dropped (cancelled) if the shell cancels it
//! (`timeout`) or the command is stopped.
//!
//! A host command gets its arguments, working directory, environment and stdin, and the shell's files as they are at
//! that moment ([`HostFiles`]: an untouched file is read through the command's workspace, one the command changed
//! comes inline). It answers its exit code, stdout and stderr, and the files it writes or removes. It never commits:
//! its writes become the shell's own changes, saved by the shell command's one commit with everything else, so a
//! stopped or cancelled command, an unknown outcome or a later command are handled once, the same way for all of
//! them. A large output is staged through the workspace first ([`HostFiles::stage`]) and answered as
//! [`HostWrite::Staged`]: the shell keeps it as a file it never reads unless the command does, and its commit names
//! the staged blob, so the bytes don't pass through the isolate.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::workspace::{BoxFuture, Staged, Workspace};

/// One host command, registered under a name. `run` may be called for several sandboxes at once.
pub trait HostCommand: Send + Sync {
    fn run<'a>(&'a self, request: HostRequest) -> BoxFuture<'a, Result<HostReply>>;
}

/// The host commands an embedder registers, by the name the shell runs them under.
pub type HostCommands = BTreeMap<String, Arc<dyn HostCommand>>;

/// The most a reply may carry inline (stdout, stderr and inline writes together); a larger output is staged.
pub const MAX_INLINE_REPLY: usize = 64 * 1024 * 1024;

/// One run of a host command.
pub struct HostRequest {
    pub sandbox_id: Arc<str>,
    pub name: String,
    pub args: Vec<String>,
    /// The shell's working directory, absolute (not necessarily under /workspace: it isn't a host path).
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
    cwd: String,
    files: HashMap<String, Indexed>,
    dirs: Vec<String>,
    payload: Arc<Vec<u8>>,
    workspace: Option<Arc<dyn Workspace>>,
}

/// `path` (absolute, or relative to `cwd`) as a path relative to `/workspace`, `.` and `..` resolved; None outside
/// it.
fn workspace_path(cwd: &str, path: &str) -> Option<String> {
    let full = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{cwd}/{path}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in full.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    if parts.first() != Some(&"workspace") {
        return None;
    }
    Some(parts[1..].join("/"))
}

impl HostFiles {
    /// The files' paths, relative to `/workspace` (directories not included).
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    /// `path` (absolute, or relative to the shell's working directory) relative to `/workspace`, if it is in it.
    pub fn resolve(&self, path: &str) -> Option<String> {
        workspace_path(&self.cwd, path)
    }

    /// Whether `path` is a directory in the shell's files.
    pub fn is_dir(&self, path: &str) -> bool {
        self.resolve(path)
            .is_some_and(|p| p.is_empty() || self.dirs.contains(&p))
    }

    /// A file's size, if it is one.
    pub fn size(&self, path: &str) -> Option<u64> {
        match self.files.get(&self.resolve(path)?)? {
            Indexed::Workspace { size, .. } => Some(*size),
            Indexed::Inline(_, len) => Some(*len as u64),
        }
    }

    /// A file's bytes, at most `cap`: `path` absolute, or relative to the shell's working directory, and in
    /// `/workspace`.
    pub async fn read(&self, path: &str, cap: usize) -> Result<Vec<u8>> {
        let rel = self
            .resolve(path)
            .ok_or_else(|| anyhow!("{path}: not in the workspace"))?;
        match self.files.get(&rel) {
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

    /// Upload an output's bytes to the workspace, for a [`HostWrite::Staged`]: nothing refers to them until the
    /// shell command's commit names them.
    pub async fn stage(&self, path: &str, bytes: Vec<u8>) -> Result<Staged> {
        let rel = self
            .resolve(path)
            .ok_or_else(|| anyhow!("{path}: not in the workspace"))?;
        let workspace = self
            .workspace
            .as_ref()
            .ok_or_else(|| anyhow!("{path}: no workspace to stage it in"))?;
        workspace.stage(&rel, bytes).await
    }
}

/// A file a host command writes: `path` absolute, or relative to the shell's working directory, and in `/workspace`.
pub enum HostWrite {
    /// Its bytes, inline in the reply.
    Bytes {
        path: String,
        bytes: Vec<u8>,
        mode: Option<u32>,
    },
    /// Bytes [`HostFiles::stage`] uploaded: the shell keeps the file without reading it.
    Staged {
        path: String,
        staged: Staged,
        mode: Option<u32>,
    },
}

/// What a host command answers.
#[derive(Default)]
pub struct HostReply {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Files it writes, applied by the shell after `removes`.
    pub writes: Vec<HostWrite>,
    /// Paths it removes (absolute, or relative to the working directory, in `/workspace`).
    pub removes: Vec<String>,
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
    let cwd = meta["cwd"].as_str().unwrap_or("/workspace").to_string();
    Ok(HostRequest {
        sandbox_id,
        name: meta["name"].as_str().unwrap_or_default().to_string(),
        args: strings(&meta["args"]),
        cwd: cwd.clone(),
        env,
        stdin,
        deadline,
        files: HostFiles {
            cwd,
            files,
            dirs,
            payload: Arc::new(payload),
            workspace,
        },
    })
}

/// A reply as the guest reads it: meta with `[offset, length]` slices of the data after it (bridges::pack's format,
/// as a node/python run's), its paths relative to `/workspace`. An error if a path is outside it or the inline
/// part is over [`MAX_INLINE_REPLY`].
pub(crate) fn pack_reply(cwd: &str, reply: &HostReply) -> Result<Vec<u8>> {
    let inline: usize = reply.stdout.len()
        + reply.stderr.len()
        + reply
            .writes
            .iter()
            .map(|w| match w {
                HostWrite::Bytes { bytes, .. } => bytes.len(),
                HostWrite::Staged { .. } => 0,
            })
            .sum::<usize>();
    if inline > MAX_INLINE_REPLY {
        bail!(
            "its output is {inline} bytes, over the {} MiB a reply carries; stage large outputs",
            MAX_INLINE_REPLY >> 20
        );
    }
    let rel = |path: &str| {
        workspace_path(cwd, path)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow!("{path}: not in the workspace"))
    };
    let mut data = Vec::with_capacity(inline);
    let mut add = |bytes: &[u8]| {
        let at = json!([data.len(), bytes.len()]);
        data.extend_from_slice(bytes);
        at
    };
    let stdout = add(&reply.stdout);
    let stderr = add(&reply.stderr);
    let mut writes = Vec::new();
    for write in &reply.writes {
        let (path, mode, mut entry) = match write {
            HostWrite::Bytes { path, bytes, mode } => (path, mode, json!({ "data": add(bytes) })),
            HostWrite::Staged { path, staged, mode } => (
                path,
                mode,
                json!({ "staged": { "blob": staged.blob, "size": staged.size } }),
            ),
        };
        entry["path"] = json!(rel(path)?);
        if let Some(mode) = mode {
            entry["mode"] = json!(mode);
        }
        writes.push(entry);
    }
    let removes = reply
        .removes
        .iter()
        .map(|p| rel(p))
        .collect::<Result<Vec<_>>>()?;
    let meta = json!({
        "exitCode": reply.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "writes": writes,
        "removes": removes,
    });
    Ok(crate::bridges::pack(&meta, &data))
}

#[cfg(test)]
mod tests {
    use super::workspace_path;

    #[test]
    fn paths_resolve_inside_the_workspace_only() {
        let cwd = "/workspace/sub";
        assert_eq!(workspace_path(cwd, "a.txt").as_deref(), Some("sub/a.txt"));
        assert_eq!(
            workspace_path(cwd, "./x/../a.txt").as_deref(),
            Some("sub/a.txt")
        );
        assert_eq!(workspace_path(cwd, "../b").as_deref(), Some("b"));
        assert_eq!(workspace_path(cwd, "/workspace/c").as_deref(), Some("c"));
        for outside in [
            "../../etc/passwd",
            "/etc/passwd",
            "/workspacex/a",
            "/../workspace/../etc",
        ] {
            assert_eq!(workspace_path(cwd, outside), None, "{outside}");
        }
        assert_eq!(workspace_path("/tmp", "a"), None);
    }
}
