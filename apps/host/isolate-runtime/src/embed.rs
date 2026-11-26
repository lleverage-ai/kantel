//! What an embedder plugs into the runtime: its guest bundle and its own ops. See EMBEDDING.md for the contract.

use std::sync::Arc;

use deno_core::Extension;

use crate::host_commands::{HostCommand, HostCommands};
use crate::workspace::FilesystemProvider;

/// The parts of the runtime an embedder chooses, given to [`Engine::init`](crate::Engine::init) once per process.
///
/// - `guest`: the guest bundle, one classic script evaluated once into the process's startup snapshot. It must define
///   `globalThis.__kantel.init(kind)` (EMBEDDING.md, "The guest bundle"); the `kantel-isolate` binary's is
///   `guest/dist/guest.js`.
/// - `extensions`: the embedder's own deno_core extensions (ops), added after the runtime's `kt` extension to the
///   snapshot and to every isolate. Called once for the snapshot and once per isolate, so it returns fresh
///   extensions each time, with the same ops in the same order every call (deno_core requires an isolate's ops to
///   match its snapshot's). An embedder's op reaches the isolate's context with
///   [`Ctx::of`](crate::Ctx::of) and must refuse to act for an isolate kind it isn't meant for, as the runtime's
///   own ops do.
/// - `filesystem`: where sandboxes' files come from and where commands' changes go (see
///   [`workspace`](crate::workspace)). None is Kantel's manifest per command, over the blob store bridge.
/// - `host_commands`: programs the embedder runs natively for the guest's shell, by name (see
///   [`host_commands`](crate::host_commands)). Kantel's has none.
/// - `kinds`: isolate kinds of the embedder's own ([`EmbedderKind`]), which it makes with
///   [`isolate::try_new_live`](crate::isolate::try_new_live). Kantel's has none.
#[derive(Clone)]
#[non_exhaustive]
pub struct Embedding {
    pub guest: &'static str,
    pub extensions: fn() -> Vec<Extension>,
    pub filesystem: Option<Arc<dyn FilesystemProvider>>,
    pub host_commands: Arc<HostCommands>,
    pub kinds: Vec<EmbedderKind>,
}

/// An isolate kind of the embedder's own, next to the runtime's shell, node and python (see EMBEDDING.md, "An
/// embedder's own kinds"). Its isolates are made with
/// [`Kind::Embedder(name)`](crate::Kind::Embedder), start with code generation from strings off, and get their entry
/// point from `__kantel.init(name)`.
///
/// - `name`: what `__kantel.init` is called with. Not `shell`, `node` or `python`, and not empty.
/// - `runtime`: the kind's own JavaScript, the body of a function evaluated once, after the guest bundle, into the
///   startup snapshot. What it returns is handed to `__kantel.init(name, runtime)` in each of the kind's isolates, so
///   they start with it evaluated, and no other kind's isolate can reach it. It must leave nothing on the global
///   ([`Engine::init`](crate::Engine::init) refuses one that does). Empty for none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct EmbedderKind {
    pub name: &'static str,
    pub runtime: &'static str,
}

impl Embedding {
    /// An embedding with this guest bundle and no ops of its own.
    pub fn new(guest: &'static str) -> Embedding {
        Embedding {
            guest,
            extensions: Vec::new,
            filesystem: None,
            host_commands: Arc::default(),
            kinds: Vec::new(),
        }
    }

    /// An isolate kind of the embedder's own, `name`, with its own `runtime` evaluated into the snapshot (see
    /// [`EmbedderKind`]). [`Engine::init`](crate::Engine::init) refuses a reserved or repeated name.
    pub fn with_kind(mut self, name: &'static str, runtime: &'static str) -> Embedding {
        self.kinds.push(EmbedderKind { name, runtime });
        self
    }

    /// A host command the guest's shell runs under `name` (see the type's docs). A name the isolate otherwise
    /// lacks (`unzip`, `duckdb`) is then served, not refused.
    pub fn with_host_command(
        mut self,
        name: impl Into<String>,
        command: Arc<dyn HostCommand>,
    ) -> Embedding {
        Arc::make_mut(&mut self.host_commands).insert(name.into(), command);
        self
    }

    /// The embedder's filesystem provider (see the type's docs).
    pub fn with_filesystem(self, filesystem: Arc<dyn FilesystemProvider>) -> Embedding {
        Embedding {
            filesystem: Some(filesystem),
            ..self
        }
    }

    /// The embedder's own ops (see the type's docs).
    pub fn with_extensions(self, extensions: fn() -> Vec<Extension>) -> Embedding {
        Embedding { extensions, ..self }
    }
}

impl std::fmt::Debug for Embedding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Embedding")
            .field("guest", &format_args!("{} bytes", self.guest.len()))
            .field(
                "kinds",
                &self.kinds.iter().map(|k| k.name).collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}
