//! What an embedder plugs into the runtime: its guest bundle and its own ops. See EMBEDDING.md for the contract.

use deno_core::Extension;

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
#[derive(Clone, Copy)]
pub struct Embedding {
    pub guest: &'static str,
    pub extensions: fn() -> Vec<Extension>,
}

impl Embedding {
    /// An embedding with this guest bundle and no ops of its own.
    pub fn new(guest: &'static str) -> Embedding {
        Embedding {
            guest,
            extensions: Vec::new,
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
