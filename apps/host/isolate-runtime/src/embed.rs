//! What an embedder plugs into the runtime: its guest bundle and its own ops. See EMBEDDING.md for the contract.

use std::sync::Arc;

use deno_core::Extension;

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
#[derive(Clone)]
pub struct Embedding {
    pub guest: &'static str,
    pub extensions: fn() -> Vec<Extension>,
    pub filesystem: Option<Arc<dyn FilesystemProvider>>,
}

impl Embedding {
    /// An embedding with this guest bundle and no ops of its own.
    pub fn new(guest: &'static str) -> Embedding {
        Embedding {
            guest,
            extensions: Vec::new,
            filesystem: None,
        }
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
            .finish_non_exhaustive()
    }
}
